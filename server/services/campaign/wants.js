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
 * (wants-grade.js) and only a family that clears the pre-registered bar may ever break a tie.
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
