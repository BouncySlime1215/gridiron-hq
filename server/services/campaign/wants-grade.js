/**
 * U8 WANTS-MENU grader (pre-registered, see the PR): does a shown "want" predict a roster move within
 * 7 days better than the trailing rate?
 *
 *   signal   { roster, player, side: 'wants' | 'gives', family: 'stated' | 'revealed', source, at (ms) }
 *   hit      wants: an executed trade moves `player` TO `roster` in (at, at + 7 d]
 *            gives: an executed trade moves `player` FROM `roster` in (at, at + 7 d]
 *   base     the same roster's trailing rate over [at - 28 d, at), per player per 7 days:
 *            gives: players it traded away / (rosterSize x 4)
 *            wants: players it traded for  / ((teamCount - 1) x rosterSize x 4)
 *   cell     family x side, graded apart (stated never pooled with revealed)
 *   PASS     n >= 20 AND Wilson 95% lower bound of the hit rate > mean base AND hit rate >= 2 x mean base
 *
 * A signal whose 7-day window has not closed by `now` is `open`, never a miss. The same (roster, player,
 * side, family) again inside 7 days of a counted one is a repeat (one screenshot posted twice is one
 * signal). Pure: trades come from trade-memory.js#executedTrades, in whatever id space the caller maps to.
 */
export const WANTS_WINDOW_DAYS = 7;
export const WANTS_TRAILING_DAYS = 28;
export const WANTS_MIN_N = 20;
export const WANTS_MIN_LIFT = 2;
const DAY = 86_400_000;
const Z = 1.959964;

/** Wilson score interval for k of n at 95%. */
export function wilson(k, n) {
  if (!(n > 0)) return { lo: null, hi: null };
  const p = k / n, d = 1 + Z * Z / n;
  const c = (p + Z * Z / (2 * n)) / d;
  const h = (Z * Math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

/**
 * signals, trades ([{ at, moves: [{ player, from, to }] }]). opts: { now, rosterSize, teamCount }.
 * -> { cells: { [family:side]: { n, hits, rate, ci, base, lift, pass } }, open, repeats, verdict: 'pass' | 'fail' }
 */
export function gradeWants(signals, trades, { now, rosterSize, teamCount, windowDays = WANTS_WINDOW_DAYS, trailingDays = WANTS_TRAILING_DAYS } = {}) {
  if (!(rosterSize > 0) || !(teamCount > 1)) throw new Error('gradeWants needs rosterSize > 0 and teamCount > 1');
  if (!Number.isFinite(now)) throw new Error('gradeWants needs now (ms)');
  const W = windowDays * DAY, T = trailingDays * DAY, weeks = trailingDays / 7;
  const moves = (trades ?? []).flatMap(t => t.moves.map(m => ({ at: t.at, player: String(m.player), from: String(m.from), to: String(m.to) })));
  const sorted = [...(signals ?? [])].filter(s => Number.isFinite(s.at)).sort((a, b) => a.at - b.at);
  const last = new Map();
  const cells = {};
  let open = 0, repeats = 0;
  for (const s of sorted) {
    const roster = String(s.roster), player = String(s.player);
    if (s.at + W > now) { open++; continue; }
    const k = `${s.family}|${s.side}|${roster}|${player}`;
    if (last.has(k) && s.at - last.get(k) < W) { repeats++; continue; }
    last.set(k, s.at);
    const wants = s.side === 'wants';
    const hit = moves.some(m => m.player === player && (wants ? m.to === roster : m.from === roster) && m.at > s.at && m.at <= s.at + W);
    const trailing = moves.filter(m => (wants ? m.to === roster : m.from === roster) && m.at >= s.at - T && m.at < s.at).length;
    const base = trailing / ((wants ? (teamCount - 1) * rosterSize : rosterSize) * weeks);
    const c = (cells[`${s.family}:${s.side}`] ??= { n: 0, hits: 0, baseSum: 0 });
    c.n++; if (hit) c.hits++; c.baseSum += base;
  }
  const out = {};
  for (const [k, c] of Object.entries(cells)) {
    const rate = c.hits / c.n, base = c.baseSum / c.n, ci = wilson(c.hits, c.n);
    out[k] = { n: c.n, hits: c.hits, rate, ci, base, lift: base > 0 ? rate / base : null,
      pass: c.n >= WANTS_MIN_N && ci.lo > base && rate >= WANTS_MIN_LIFT * base };
  }
  return { cells: out, open, repeats, verdict: Object.values(out).some(c => c.pass) ? 'pass' : 'fail',
    bar: `n >= ${WANTS_MIN_N}, Wilson 95% lower bound > trailing base, hit rate >= ${WANTS_MIN_LIFT}x base; per family x side` };
}

/**
 * Revealed signals from people/chat-trade-interest.js#readChatTradeInterest (rows carry espn ids), in espn-id
 * space to match executedTrades({ idOfEspn: String }). toMs(v) -> ms or null. Unmapped players are counted.
 */
export function revealedSignals(read, toMs) {
  if (read?.status !== 'ok') return { signals: [], unmapped: 0, status: String(read?.status ?? 'unread') };
  const signals = [];
  let unmapped = 0;
  for (const r of read.rows) {
    const at = toMs(r.seen_at);
    if (at == null) continue;
    for (const [side, list] of [['wants', r.wants], ['gives', r.would_give]]) {
      for (const p of list) {
        if (!(Number(p.espn_id) > 0)) { unmapped++; continue; }
        signals.push({ roster: String(r.roster_id), player: String(p.espn_id), side, family: 'revealed', source: `screen:${r.kind}`, at });
      }
    }
  }
  return { signals, unmapped, status: 'ok' };
}

/**
 * Stated signals from people.profile (people/profile-reader.js#peopleProfile): each roster's chat asks
 * (values_talk wants) and chat shopping, via counterpart.js#valuesTalk. resolve(name) -> espn id or null.
 * A mention with no date of its own is dated at the profile's build time (counted in `undated`).
 */
export function statedSignals(people, { valuesTalk, resolve, toMs }) {
  if (!people?.available) return { signals: [], unresolved: 0, undated: 0, status: 'unknown', reason: String(people?.reason ?? 'not read') };
  const signals = [];
  let unresolved = 0, undated = 0;
  for (const [roster, entry] of people.byRoster ?? new Map()) {
    if (entry?.status !== 'ok') continue;
    const vt = valuesTalk(entry.profile, toMs(entry.built_at));
    if (vt?.status !== 'ok') continue;
    for (const [side, list, source] of [['wants', vt.wants, 'chat_ask'], ['gives', vt.shopping, 'chat_shop']]) {
      for (const m of list) {
        const id = resolve(m.player);
        if (id == null) { unresolved++; continue; }
        if (m.at == null) continue;
        if (!m.dated) undated++;
        signals.push({ roster: String(roster), player: String(id), side, family: 'stated', source, at: m.at });
      }
    }
  }
  return { signals, unresolved, undated, status: 'ok' };
}
