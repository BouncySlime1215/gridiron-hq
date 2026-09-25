/**
 * U8 WANTS-MENU (batch D item 3, flag GRIDIRON_WANTS, SHADOW): seed each league-mate's trade menu with
 * what he has shown he wants, from the three reads the producer already holds. No new reader.
 *
 *   stated    what he SAID: his chat asks and chat shopping list (people/counterpart.js#publicModel
 *             wants / shopping) and his ESPN trade block (espn-trade-block.js via his-side.js#tradeBlockRead),
 *             a label he set by hand.
 *   revealed  what he DID: the trades he composed himself, his own finalize drafts and trade-analyzer
 *             screens in the league chat (people/chat-trade-interest.js via his-side.js#chatInterestRead).
 *
 * The two families are never merged into one list or one number: each is graded on its own
 * (gradeWants below) and only a family that clears the pre-registered bar may ever break a tie.
 *
 * NICK'S RULES ARE FILTERS HERE TOO. The give menu (Nick's players he wants) never lists a never-give id
 * (never-give.js PINNED_NEVER_GIVE plus the adapter's untouchables); the get menu (his players he would
 * give) never lists a never-get id, a player Nick sold this season (no buy-backs from any team), a player
 * below the Blue chip floor or one the board does not score. Each drop is counted by reason, so the
 * surface can say "N ideas hidden by your rules". A player with no FantasyCalc value (fc-value.js, via the
 * adapter's players[].value) is dropped, never priced by a fallback.
 *
 * SHADOW. Off (default), the planner does not call this file and plans.json is byte-identical. On, it
 * writes `_run.inputs.wants` (menus + the tie-break it WOULD make) and nothing served moves: no order,
 * no number. GRIDIRON_PREVIEW_UNCONFIRMED does not switch it on.
 *
 * Pure: no DB, env or clock. Ids only (roster ids and planner player ids), never a name.
 */
import { PINNED_NEVER_GIVE, PINNED_NEVER_GET } from './never-give.js';
import { BLUE_CHIP_SCORE } from './search.js';

export const WANTS_FLAG = 'GRIDIRON_WANTS';
/** Only its own flag switches it on; the preview switch does not. */
export const wantsOn = (env = {}) => (env ?? {})[WANTS_FLAG] === '1';

export const FAMILIES = Object.freeze(['stated', 'revealed']);
const S = x => String(x);
const EPS = 1e-9;

const emptyTeam = () => ({ stated: { wants: new Map(), gives: new Map() }, revealed: { wants: new Map(), gives: new Map(), screens: 0 } });
const add = (m, id, source) => { const k = S(id); const s = m.get(k) ?? new Set(); s.add(source); m.set(k, s); };
const listOf = m => [...m].map(([player, src]) => ({ player, sources: [...src].sort() }));

/**
 * models: people/counterpart.js#publicModel list (or null: counterpart off). block: his-side.js#tradeBlockRead
 * (or null). interest: his-side.js#chatInterestRead (or null).
 * -> { reads: { chat, espn_block, screens }, by_team: { [roster]: { stated: { wants, gives }, revealed: { wants, gives, screens } } } }
 *    each list [{ player, sources }]; a read that is not 'ok' contributes nothing and says so in `reads`.
 */
export function wantsRead({ models = null, block = null, interest = null } = {}) {
  const teams = new Map();
  const team = t => { const k = S(t); if (!teams.has(k)) teams.set(k, emptyTeam()); return teams.get(k); };
  const okModels = (models ?? []).filter(m => m?.status === 'ok');
  for (const m of okModels) {
    const t = team(m.team);
    for (const w of m.wants ?? []) add(t.stated.wants, w.player, 'chat_ask');
    for (const id of m.shopping ?? []) add(t.stated.gives, id, 'chat_shop');
  }
  if (block?.status === 'ok') {
    for (const [r, ids] of Object.entries(block.by_team ?? {})) for (const id of ids) add(team(r).stated.gives, id, 'espn_block');
  }
  if (interest?.status === 'ok') {
    for (const [r, x] of Object.entries(interest.by_team ?? {})) {
      const t = team(r);
      t.revealed.screens += Number(x.n) || 0;
      for (const id of x.wants ?? []) add(t.revealed.wants, id, 'screen');
      for (const id of x.would_give ?? []) add(t.revealed.gives, id, 'screen');
    }
  }
  const state = (x, on) => (!x ? 'unread' : on ? 'ok' : S(x.status ?? 'unknown'));
  const by_team = {};
  for (const [k, t] of teams) {
    by_team[k] = { stated: { wants: listOf(t.stated.wants), gives: listOf(t.stated.gives) },
      revealed: { wants: listOf(t.revealed.wants), gives: listOf(t.revealed.gives), screens: t.revealed.screens } };
  }
  return {
    reads: { chat: models == null ? 'unread' : okModels.length ? 'ok' : 'none', espn_block: state(block, block?.status === 'ok'),
      screens: state(interest, interest?.status === 'ok') },
    by_team,
  };
}

/**
 * The menus, rule-filtered. read: wantsRead. me: Nick's roster id. rosters: Map roster -> [player ids].
 * untouchable: the adapter's untouchable set (never-give.js#withNeverGive already applied). fcOf(id) ->
 * FantasyCalc value or null. scoreOf(id) -> board score, { score }, or null (null function: no board, every get
 * withheld as unscored). sold: Set of ids Nick sold this season, or null when the ledger was not read
 * (then every get is withheld: the no-buy-back rule cannot be checked, so it fails closed).
 * -> { teams: [{ team, give: { stated, revealed }, get: { stated, revealed } }], hidden: { reason: n }, hidden_total }
 *    each menu row { player, fc, sources }, highest fc first.
 */
export function wantsMenu(read, { me, rosters, untouchable = new Set(), fcOf, scoreOf = null, sold = null }) {
  const mine = new Set((rosters.get(me) ?? rosters.get(S(me)) ?? []).map(S));
  const blockedGive = new Set([...PINNED_NEVER_GIVE, ...[...untouchable].map(S)]);
  const blockedGet = new Set([...PINNED_NEVER_GET, ...[...untouchable].map(S)]);
  const hidden = {};
  const hide = r => { hidden[r] = (hidden[r] ?? 0) + 1; };
  const byFc = (a, b) => (b.fc - a.fc) || (a.player < b.player ? -1 : 1);

  const giveRow = x => {
    if (!mine.has(x.player)) return null;                 // he wants someone Nick does not have: not a give
    if (blockedGive.has(x.player)) { hide('never_give'); return null; }
    const fc = fcOf(x.player);
    if (!Number.isFinite(fc)) { hide('no_fc_value'); return null; }
    return { player: x.player, fc, sources: x.sources };
  };
  const getRow = theirs => x => {
    if (!theirs.has(x.player)) return null;               // stale: he no longer holds him
    if (blockedGet.has(x.player)) { hide('never_get'); return null; }
    if (sold == null) { hide('rules_unreadable'); return null; }
    if (sold.has(x.player)) { hide('sold_this_season'); return null; }
    const r = scoreOf ? scoreOf(x.player) : null;
    const s = r != null && typeof r === 'object' ? r.score : r;
    if (!Number.isFinite(s)) { hide('unscored'); return null; }
    if (s < BLUE_CHIP_SCORE) { hide('below_blue_chip'); return null; }
    const fc = fcOf(x.player);
    if (!Number.isFinite(fc)) { hide('no_fc_value'); return null; }
    return { player: x.player, fc, sources: x.sources };
  };

  const teams = [];
  for (const [team, t] of Object.entries(read.by_team ?? {})) {
    if (team === S(me)) continue;
    const theirs = new Set((rosters.get(Number(team)) ?? rosters.get(team) ?? []).map(S));
    const menu = { team,
      give: Object.fromEntries(FAMILIES.map(f => [f, t[f].wants.map(giveRow).filter(Boolean).sort(byFc)])),
      get: Object.fromEntries(FAMILIES.map(f => [f, t[f].gives.map(getRow(theirs)).filter(Boolean).sort(byFc)])) };
    if (FAMILIES.some(f => menu.give[f].length || menu.get[f].length)) teams.push(menu);
  }
  teams.sort((a, b) => (a.team < b.team ? -1 : 1));
  return { teams, hidden, hidden_total: Object.values(hidden).reduce((s, n) => s + n, 0) };
}

/** A plan's first step against the partner's menu, per family: how many of its gives he wants, how many of its gets he would give. */
export function wantsMatch(menu, step) {
  const m = menu.teams.find(t => t.team === S(step?.team));
  const out = {};
  for (const f of FAMILIES) {
    const give = new Set((m?.give[f] ?? []).map(x => x.player));
    const get = new Set((m?.get[f] ?? []).map(x => x.player));
    out[f] = (step?.give ?? []).filter(id => give.has(S(id))).length + (step?.get ?? []).filter(id => get.has(S(id))).length;
  }
  return out;
}

/**
 * The tie-break it WOULD make (shadow: the served order is untouched). ranked: rankPlans(...).ranked for the
 * served mode. Only plans that already passed every rule and tie on score (|diff| <= 1e-9) are compared, one
 * family at a time. -> { tied_pairs, would_reorder: { stated, revealed }, pairs: [{ at, a, b, stated, revealed }] }
 */
export function wantsTieBreak(ranked, menu) {
  const key = p => `${S(p.target)}@${S(p.steps?.[0]?.team)}`;
  const pairs = [];
  const would = { stated: 0, revealed: 0 };
  for (let i = 0; i + 1 < (ranked ?? []).length; i++) {
    const a = ranked[i], b = ranked[i + 1];
    if (!(Math.abs(Number(a.score) - Number(b.score)) <= EPS)) continue;
    const ma = wantsMatch(menu, a.steps?.[0]), mb = wantsMatch(menu, b.steps?.[0]);
    const row = { at: i, a: key(a), b: key(b) };
    for (const f of FAMILIES) {
      row[f] = mb[f] > ma[f] ? 'swap' : 'keep';
      if (row[f] === 'swap') would[f]++;
    }
    pairs.push(row);
  }
  return { tied_pairs: pairs.length, would_reorder: would, pairs };
}

/** `_run.inputs.wants`: ids only. */
export function wantsSummary(read, menu, tie) {
  const count = side => Object.fromEntries(FAMILIES.map(f => [f, menu.teams.reduce((s, t) => s + t[side][f].length, 0)]));
  return { flag: 'shadow', reads: read.reads, teams: menu.teams.length, give_rows: count('give'), get_rows: count('get'),
    hidden_by_rules: menu.hidden_total, hidden: menu.hidden, menus: menu.teams, tie_break: tie };
}

/**
 * The planner's one call (flag on only). adapter: the planner's adapter (never-give already applied).
 * ranked: the served mode's rankPlans rows. models: publicModel list or null. sold: trade memory's sold
 * ids (Set) or null when the ledger was not read. -> wantsSummary.
 */
export function wantsShadow(adapter, { me, ranked, models = null, sold = null }) {
  const read = wantsRead({ models, block: adapter.tradeBlock ?? null, interest: adapter.chatInterest ?? null });
  const pl = id => adapter.players?.get(id) ?? adapter.players?.get(Number(id)) ?? null;
  const scoreOf = typeof adapter.scoreOf === 'function' ? id => adapter.scoreOf(id) ?? adapter.scoreOf(Number(id)) : null;
  const menu = wantsMenu(read, { me, rosters: adapter.rosters, untouchable: adapter.untouchable ?? new Set(),
    fcOf: id => { const v = pl(id)?.value; return v == null ? null : Number(v); }, scoreOf, sold });
  return wantsSummary(read, menu, wantsTieBreak(ranked, menu));
}

/* ------------------------------------------------------------------ the grader */

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
 * signal). Kept in this file so the grader ships with what it grades. Pure: trades come from trade-memory.js#executedTrades, in whatever id space the caller maps to.
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
