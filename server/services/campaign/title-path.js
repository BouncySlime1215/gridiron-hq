/**
 * TITLE-PATH EXPLAINER (plan item 41): for the served next move, three plain-English lines on
 * why it wins the title, built from plan numbers only:
 *
 *   slot   the lineup slot the move fixes: the get's position and the starter he replaces, both
 *          by the same rest-of-season points a game the planner ranked on (adapter players.ros_ppg)
 *   weeks  the weeks it matters: Nick's lineup points a week on the world's weekly draws, after
 *          minus now, from the week the move lands (planner eta_week) to the last simulated week
 *   odds   title odds before -> after: title_now, title_now + delta_final (if every step lands) and
 *          title_now + expected (counting a "no"), with the plan's SE and the guess label on P(complete)
 *
 * Every number printed is also returned in `numbers`, rounded exactly as printed, so a grounding
 * check can match each figure in the text to a plan number (test/campaign-title-path.test.js E1).
 *
 * Nick's rules: it explains only the planner's served, rule-filtered move. As a second line of
 * defence it refuses (status 'refused', no text) any move that gives or gets a blocked id: his
 * untouchables, the pinned never-give ids (never-give.js: 160, 80, 277) and never-get ids (290).
 *
 * Flag GRIDIRON_TITLE_PATH: only '1' computes it, and then as SHADOW: the producer writes it to
 * `_run.inputs.title_path`, which no screen reads. Unset or anything else is off, preview mode
 * included; off, the plans file is byte-for-byte the incumbent's. It moves no number.
 */
import { PINNED_NEVER_GIVE, PINNED_NEVER_GET } from './never-give.js';

export const TITLE_PATH_ENV = 'GRIDIRON_TITLE_PATH';
/** A week counts as "where it matters" when the lineup gains at least this many points in it. */
export const MIN_WEEK_GAIN = 0.5;
/** At most this many weeks are named on the weeks line. */
export const TOP_WEEKS = 3;
/** Weeks are named only when the best and worst week differ by at least this many points. */
export const WEEK_SPREAD = 1;
/** Each line stays short enough to read on a phone. */
export const MAX_LINE = 180;

/** 'shadow' | 'off'. Only its own flag turns it on; preview mode never does. */
export function titlePathFlag(env = process.env) {
  return env?.[TITLE_PATH_ENV] === '1' ? 'shadow' : 'off';
}

const S = x => String(x);
const fin = Number.isFinite;
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const r1 = x => Math.round(x * 10) / 10;
/** Title odds as a percent with one decimal, the way the War Room prints them. */
const pct = x => r1(x * 100);
const signed = x => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;

/** What Nick holds after every step: his roster minus everything given plus everything got, in order. */
export function finalRoster(roster, steps) {
  const out = roster.map(S);
  for (const st of steps ?? []) {
    for (const id of st.give ?? []) { const i = out.indexOf(S(id)); if (i >= 0) out.splice(i, 1); }
    for (const id of st.get ?? []) if (!out.includes(S(id))) out.push(S(id));
  }
  return out;
}

/** Ids the move gives or gets that Nick's rules block (empty: the move is clean). */
export function blockedInMove(steps, { untouchable = [], mine = [] } = {}) {
  const mineSet = new Set(mine.map(S));
  const blocked = new Set([...[...untouchable].map(S), ...PINNED_NEVER_GET]);
  for (const id of PINNED_NEVER_GIVE) if (mineSet.has(id)) blocked.add(id);
  const hits = new Set();
  for (const st of steps ?? []) for (const id of [...(st.give ?? []), ...(st.get ?? [])]) if (blocked.has(S(id))) hits.add(S(id));
  return [...hits];
}

/**
 * The slot line. players: Map id -> { name, position, ros_ppg }; starters: ids starting today.
 * For each net get, the starter he takes the place of: a starter at his position whom the move gives
 * away, else the weakest starter at his position he outscores, else (RB / WR / TE) the weakest
 * flex-eligible starter he outscores, at FLEX. The line names the get with the biggest points-a-game
 * change over the player he replaces. If no get replaces a starter, it says the best one is depth.
 */
export const FLEX_POSITIONS = Object.freeze(['RB', 'WR', 'TE']);

export function slotLine({ roster, steps, players, starters }) {
  const P = id => players.get(id) ?? players.get(Number(id)) ?? players.get(S(id)) ?? null;
  const start = new Set(roster.map(S));
  const end = new Set(finalRoster(roster, steps));
  const gets = [...end].filter(id => !start.has(id)).map(id => ({ id, p: P(id) })).filter(x => x.p && fin(x.p.ros_ppg));
  const gives = new Set([...start].filter(id => !end.has(id)));
  if (!gets.length) return { status: 'unknown', reason: 'The move brings back no player with a rest-of-season rate.' };
  const current = [...(starters ?? [])].map(S).filter(id => start.has(id) && fin(P(id)?.ros_ppg))
    .map(id => ({ id, p: P(id) })).sort((a, b) => a.p.ros_ppg - b.p.ros_ppg);
  const taken = new Set();
  const rows = gets.sort((a, b) => b.p.ros_ppg - a.p.ros_ppg).map(g => {
    const free = current.filter(x => !taken.has(x.id));
    const same = free.filter(x => x.p.position === g.p.position);
    const flex = FLEX_POSITIONS.includes(g.p.position) ? free.filter(x => FLEX_POSITIONS.includes(x.p.position)) : [];
    const pick = same.find(x => gives.has(x.id)) ?? same.find(x => x.p.ros_ppg < g.p.ros_ppg);
    const out = pick ? { ...pick, slot: g.p.position } : (() => { const f = flex.find(x => x.p.ros_ppg < g.p.ros_ppg); return f ? { ...f, slot: 'FLEX' } : null; })();
    if (out) taken.add(out.id);
    return { g, out, gain: out ? g.p.ros_ppg - out.p.ros_ppg : -Infinity };
  });
  const best = rows.filter(r => r.out).sort((a, b) => b.gain - a.gain)[0] ?? null;
  if (!best) {
    const g = rows[0].g, pos = g.p.position, getPpg = r1(g.p.ros_ppg);
    return { status: 'ok', get: g.id, replaces: null, position: pos,
      text: `${g.p.name} (${getPpg} pts a game) adds ${pos} depth; he does not outscore your starters today.`,
      numbers: [getPpg] };
  }
  const { g, out } = best;
  const getPpg = r1(g.p.ros_ppg), outPpg = r1(out.p.ros_ppg);
  const traded = gives.has(out.id) ? ', whom you trade away' : '';
  return { status: 'ok', get: g.id, replaces: out.id, position: out.slot, gain_ppg: r1(g.p.ros_ppg - out.p.ros_ppg),
    text: `Fixes your ${out.slot} slot: ${g.p.name} (${getPpg} pts a game) starts over ${out.p.name} (${outPpg})${traded}.`,
    numbers: [getPpg, outPpg] };
}

/**
 * The weeks line. nowWeeks / afterWeeks: [{ week, samples }] (the world's weekly lineup draws for
 * today's roster and the roster after the move); from: the week the move lands.
 * playoffWeeks: optional week numbers to call out as the playoffs (none: not named).
 */
export function weeksLine({ nowWeeks, afterWeeks, from, playoffWeeks = null }) {
  if (!Array.isArray(nowWeeks) || !Array.isArray(afterWeeks) || !nowWeeks.length) {
    return { status: 'unknown', reason: 'No weekly lineup draws this run.' };
  }
  const before = new Map(nowWeeks.map(w => [w.week, mean(w.samples)]));
  const rows = afterWeeks.filter(w => before.has(w.week) && (!fin(from) || w.week >= from))
    .map(w => ({ week: w.week, delta: r1(mean(w.samples) - before.get(w.week)) })).filter(r => fin(r.delta));
  if (!rows.length) return { status: 'unknown', reason: 'The move lands after the last simulated week.' };
  const perWeek = r1(mean(rows.map(r => r.delta)));
  const first = rows[0].week;
  // Weeks are named only when they stand out: WEEK_SPREAD points or more between the best and worst week.
  const spread = Math.max(...rows.map(r => r.delta)) - Math.min(...rows.map(r => r.delta));
  const top = spread < WEEK_SPREAD ? [] : rows.filter(r => r.delta >= MIN_WEEK_GAIN).sort((a, b) => b.delta - a.delta || a.week - b.week)
    .slice(0, TOP_WEEKS).sort((a, b) => a.week - b.week);
  const po = Array.isArray(playoffWeeks) && playoffWeeks.length ? rows.filter(r => playoffWeeks.includes(r.week)) : [];
  const poAvg = po.length ? r1(mean(po.map(r => r.delta))) : null;
  const numbers = [perWeek, first, ...top.flatMap(r => [r.week, r.delta])];
  let text = `Your lineup gains ${signed(perWeek)} pts a week from week ${first}`;
  if (top.length) text += `; most in week${top.length > 1 ? 's' : ''} ${top.map(r => r.week).join(', ')} (${top.map(r => signed(r.delta)).join(', ')})`;
  else if (perWeek >= MIN_WEEK_GAIN) text += ', about the same every week';
  else text += '; no week gains more than half a point';
  if (poAvg != null) {
    text += `; playoff weeks ${po[0].week}-${po[po.length - 1].week}: ${signed(poAvg)} a week`;
    numbers.push(po[0].week, po[po.length - 1].week, poAvg);
  }
  return { status: 'ok', per_week: perWeek, from: first, top, playoff_per_week: poAvg, text: `${text}.`, numbers };
}

/** The odds line: title_now -> if every step lands -> counting a "no", with the plan's SE and the guess label. */
export function oddsLine({ titleNow, plan }) {
  if (!fin(titleNow) || !fin(plan?.delta_final) || !fin(plan?.expected)) {
    return { status: 'unknown', reason: 'The plan carries no title odds for this move.' };
  }
  const now = pct(titleNow), land = pct(titleNow + plan.delta_final), exp = pct(titleNow + plan.expected);
  const se = fin(plan.expected_se) ? r1(plan.expected_se * 100) : null;
  const pc = fin(plan.p_complete) ? Math.round(plan.p_complete * 100) : null;
  const n = plan.steps?.length ?? 0;
  let text = `Title odds ${now}% now, ${land}% if ${n === 1 ? 'the trade lands' : `all ${n} steps land`}, ${exp}% counting the chance of a no`;
  if (se != null) text += ` (give or take ${se})`;
  if (pc != null) text += `; it completes ${pc}% of the time, a guess`;
  const numbers = [now, land, exp, ...(se != null ? [se] : []), ...(pc != null ? [pc] : []), ...(n > 1 ? [n] : [])];
  return { status: 'ok', now, if_lands: land, expected: exp, se, p_complete: pc, text: `${text}.`, numbers };
}

/**
 * The three lines for the served move, or why there are none.
 * plan: the served move (planner best, with steps[].give/get and the last step's state for weeklyOf).
 * -> { status: 'ok' | 'unknown' | 'refused', lines?, slot, weeks, odds, numbers, reason?, blocked? }
 */
export function titlePath({ plan, titleNow, roster, players, starters, weeklyOf = null, from = null, playoffWeeks = null,
  untouchable = [] }) {
  if (!plan || !plan.steps?.length) return { status: 'unknown', reason: 'No move clears this week, so there is no path to explain.' };
  const blocked = blockedInMove(plan.steps, { untouchable, mine: roster });
  if (blocked.length) return { status: 'refused', reason: 'The move names a player your rules block.', blocked };
  const slot = slotLine({ roster, steps: plan.steps, players, starters });
  let weeks;
  try {
    const last = plan.steps[plan.steps.length - 1];
    weeks = weeklyOf ? weeksLine({ nowWeeks: weeklyOf(null), afterWeeks: weeklyOf(last), from, playoffWeeks })
      : { status: 'unknown', reason: 'No weekly lineup draws this run.' };
  } catch (e) {
    weeks = { status: 'unknown', reason: `Weekly lineup draws failed: ${e.message ?? e}` };
  }
  const odds = oddsLine({ titleNow, plan });
  const parts = [slot, weeks, odds];
  const lines = parts.filter(x => x.status === 'ok').map(x => x.text);
  const numbers = parts.flatMap(x => x.numbers ?? []);
  return { status: lines.length ? 'ok' : 'unknown', lines, slot, weeks, odds, numbers,
    ...(lines.length ? {} : { reason: 'None of the three lines could be built from this plan.' }) };
}

/** Raw engine text a line must never carry: snake_case fields, file names, source tags, bare ids. */
export const DEV_TEXT = /[a-z]+_[a-z_]+|\.m?js\b|\b(sim|plan|clone)\.[a-z]+|\bplayer \d+\b|\bid \d+\b/i;

/** What the producer writes under `_run.inputs.title_path` (ids and plan numbers; the lines themselves). */
export function titlePathSummary(tp) {
  return {
    mode: tp.mode ?? 'shadow', status: tp.status, lines: tp.lines ?? [], numbers: tp.numbers ?? [],
    ...(tp.reason ? { reason: tp.reason } : {}),
    ...(tp.blocked ? { blocked: tp.blocked } : {}),
    ...(tp.slot ? { slot: { status: tp.slot.status, get: tp.slot.get ?? null, replaces: tp.slot.replaces ?? null, position: tp.slot.position ?? null } } : {}),
    ...(tp.weeks ? { weeks: { status: tp.weeks.status, per_week: tp.weeks.per_week ?? null, from: tp.weeks.from ?? null, top: tp.weeks.top ?? [] } } : {}),
    ...(tp.odds ? { odds: { status: tp.odds.status, now: tp.odds.now ?? null, if_lands: tp.odds.if_lands ?? null, expected: tp.odds.expected ?? null } } : {}),
  };
}
