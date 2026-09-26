/**
 * NEVER-GIVE: Nick's players no plan may offer, pinned by id so the rule holds even when his
 * 'untouchable:' notes are missing or unread (the notes-derived set fails open). Nick 9/24 (ONE-PLAN
 * 10b.3): Nico Collins (160) and Chase Brown (80) stay untouchable in every mode. A.J. Brown (277)
 * is pinned here too. AJ-PICK (Nick 2026-09-25): the automated "consistent" reader failed its prereg
 * (#483), so 277 moves only for a player Nick picked himself (aj.allow, campaign/aj-pick.js) who is a
 * Blue chip (83+) at serve time, and every such card needs Nick's OK before it can be the next move.
 * Applies to Nick's own roster only: these ids are never a give, walk-away or flip leg otherwise.
 *
 * RULES-EVERYWHERE: this file is also the ONE rule gate every other trade-suggesting surface calls
 * (trade finder, post-draft plan, proposals, offers, sequences, Trade Lab, edge, execution slate,
 * negotiate, Coach, drafts). See ruleGate() below. The War Room planner keeps its own in-search
 * filters (they prune the search); the gate is the last check before anything is returned elsewhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { overpayPct, DEPTH_PREMIUM_MAX, BLUE_CHIP_SCORE, NEVER_DEPTH } from './search.js';
import { executedTrades, tradeMemory } from './trade-memory.js';
import { warRoomPlansPath } from '../warroom-flag.js';
import { fcValues } from '../fc-value.js';
import { AJ_ID, ajState, ajPickOn } from './aj-pick.js';

export const PINNED_NEVER_GIVE = Object.freeze(['160', '80', '277']);

/**
 * NEVER-GET (integration-7): players no plan may bring back, pinned by id so the rule holds even when
 * the season trade ledger is missing. Chris Olave (290), whom Nick sold this season (no buy-backs, no
 * exceptions). Added to adapter.untouchable, which the planner already reads as never a target, a get,
 * a filler, a flip leg, a ladder row or a catch-up move.
 */
export const PINNED_NEVER_GET = Object.freeze(['290']);

/**
 * The adapter with the pinned never-give ids on Nick's roster and the pinned never-get ids on anyone
 * else's roster added to adapter.untouchable (nothing else changes). `league`: the league's own
 * never_give / never_get ids (PER-LEAGUE RULES, resolveLeagueRules), added the same way on top of the pins.
 */
export function withNeverGive(adapter, league = null) {
  const mine = new Set((adapter.rosters?.get(adapter.league?.me) ?? []).map(String));
  const theirs = new Set([...(adapter.rosters ?? new Map())].filter(([t]) => String(t) !== String(adapter.league?.me)).flatMap(([, ids]) => ids.map(String)));
  const give = [...PINNED_NEVER_GIVE, ...(league?.never_give ?? []).map(String)];
  const get = [...PINNED_NEVER_GET, ...(league?.never_get ?? []).map(String)];
  const pinned = [...new Set([...give.filter(id => mine.has(id)), ...get.filter(id => theirs.has(id))])];
  if (!pinned.length) return adapter;
  return { ...adapter, untouchable: new Set([...[...(adapter.untouchable ?? [])].map(String), ...pinned]) };
}

/* ------------------------------------------------------------------ FantasyCalc value */
// Nick's overpay rule is on FantasyCalc value through the ONE reader, server/services/fc-value.js
// (#410): no fc_value row -> null, never a fallback number, so the gate fails closed on it.

/* ------------------------------------------------------------------ the rules, pure */

const S = x => String(x);
const EPS = 1e-9;
/** Why a suggestion was dropped (counted per surface under dropped_by_rule). */
export const RULE_REASONS = Object.freeze(['never_give', 'never_get', 'sold_this_season', 'below_blue_chip',
  'unscored', 'no_fc_value', 'overpay', 'rules_unreadable']);

/**
 * AJ-PICK: A.J. Brown (277) may move in a step only when that step's gets hold a player on Nick's
 * aj.allow list for this league who is a Blue chip (83+) on the served board now. No list, an
 * unscored or sub-83 pick, or a pick only elsewhere in the path: false (fail closed).
 * rules: { scoreOf(id) -> number|null, ajAllow?: Set<id> }.
 */
export function ajMayMove(get, { scoreOf, ajAllow = null }) {
  if (!(ajAllow instanceof Set) || !ajAllow.size) return false;
  return get.some(id => ajAllow.has(S(id)) && (scoreOf(id) ?? -Infinity) >= BLUE_CHIP_SCORE);
}

/** Whether a given player is depth for the +12% exception: scored below a blue chip and never pinned. */
const depthFor = (rules, id) => {
  const s = rules.scoreOf(id);
  return s != null && s < BLUE_CHIP_SCORE && !NEVER_DEPTH.has(S(id)) && !rules.neverGive.has(S(id));
};

/**
 * One suggestion against Nick's rules, from Nick's side.
 * rules: { neverGive: Set, neverGet: Set, sold: Set, fc: Map id -> value, scoreOf(id) -> number|null,
 *   closed: string|null, ajAllow?: Set (AJ-PICK), floor?, overpayCap?, depthPremiumMax? } (the last
 *   three from the league's rules block under GRIDIRON_PER_LEAGUE_RULES; absent -> 83, 0 and +12%, Nick's league-4 rules).
 * t: { give: id[], get: id[], premium?: { points_delta, title_delta } } (premium only where the surface
 *   computed Nick's own change in lineup points and title odds for this trade; otherwise the +12%
 *   depth-only 2-for-1 exception does not apply).
 * -> { ok, reasons: string[], overpay: number|null, requires_nick_confirm: boolean }
 * requires_nick_confirm: the step gives A.J. Brown under AJ-PICK; it passes the rules but may be served
 * only as a "Needs your OK" card until Nick confirms that exact card (ruleGate below keeps it only then).
 */
export function ruleVerdict(rules, { give = [], get = [], premium = null }) {
  const g = give.map(S), r = get.map(S);
  const reasons = new Set();
  if (rules.closed) reasons.add('rules_unreadable');
  let needsOk = false;
  for (const id of g) {
    if (id === AJ_ID && rules.neverGive.has(id)) {
      if (ajMayMove(r, rules)) needsOk = true;
      else reasons.add('never_give');
    } else if (rules.neverGive.has(id)) reasons.add('never_give');
  }
  for (const id of r) {
    if (rules.neverGet.has(id)) reasons.add('never_get');
    if (rules.sold.has(id)) reasons.add('sold_this_season');
    // The Blue chip floor, as the War Room planner (GETS-FLOOR): everything Nick gets must score 83+ on the
    // served board; a player the board does not score is unscored and fails closed, never certified.
    const s = rules.scoreOf(id);
    if (s == null) reasons.add('unscored');
    else if (s < (rules.floor ?? BLUE_CHIP_SCORE)) reasons.add('below_blue_chip');
  }
  const priced = [...g, ...r].every(id => rules.fc.has(id));
  let over = null;
  if (!priced) reasons.add('no_fc_value');
  else {
    const gv = g.reduce((s, id) => s + rules.fc.get(id), 0);
    const rv = r.reduce((s, id) => s + rules.fc.get(id), 0);
    over = overpayPct(gv, rv);
    if (over > (rules.overpayCap ?? 0) + EPS) {
      const twoForOne = g.length === 2 && r.length === 1 && g.every(id => depthFor(rules, id));
      const rises = Number(premium?.points_delta) > 0 && Number(premium?.title_delta) > 0;
      if (!(twoForOne && rises && over <= (rules.depthPremiumMax ?? DEPTH_PREMIUM_MAX) + EPS)) reasons.add('overpay');
    }
  }
  return { ok: reasons.size === 0, reasons: [...reasons], overpay: over, requires_nick_confirm: needsOk };
}

/* ------------------------------------------------------------------ readers */

/** Nick's team in one league: the app's own mark (leagues.my_team_id). Reads no other column. */
export function nickTeamOf(db, leagueId) {
  const lg = db.row('SELECT id, season, my_team_id FROM leagues WHERE id = ?', Number(leagueId));
  if (!lg || lg.my_team_id == null || lg.my_team_id === '') return null;
  return { leagueId: Number(lg.id), season: Number(lg.season), me: S(lg.my_team_id) };
}

/**
 * Players Nick traded away this season in this league (TRADE-MEMORY's reader over
 * league_transactions_raw; ESPN ids joined on players.espn_id, placeholder 0 and ambiguous ids never
 * guessed). -> { status: 'ok' | 'no_table' | 'ledger_missing' | 'error', sold: Set, unmapped, reason? }
 * 'ledger_missing' and 'error' fail closed (the gate drops everything: a sold player could be served).
 */
export function soldThisSeason(db, { leagueId, season, me, now = Date.now() }) {
  try {
    const has = db.row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'league_transactions_raw'`);
    if (!has) return { status: 'no_table', sold: new Set(), unmapped: 0 };
    const rows = db.rows(`SELECT tx_id, type, status, execution_type, items_json, proposed_at, processed_at
      FROM league_transactions_raw WHERE league_id = ? AND season = ? AND type = 'TRADE_ACCEPT'`, Number(leagueId), Number(season));
    const espn = new Set();
    for (const x of rows) { try { for (const i of JSON.parse(x.items_json || '[]')) if (Number(i?.playerId) > 0) espn.add(Number(i.playerId)); } catch { /* executedTrades throws on it below */ } }
    const byEspn = new Map();
    if (espn.size) {
      const ids = [...espn];
      const found = db.rows(`SELECT id, espn_id FROM players WHERE espn_id IN (${ids.map(() => '?').join(', ')})`, ...ids);
      const hits = new Map();
      for (const f of found) hits.set(S(f.espn_id), [...(hits.get(S(f.espn_id)) ?? []), S(f.id)]);
      for (const [e, list] of hits) if (list.length === 1) byEspn.set(e, list[0]);
    }
    const { trades, unmapped } = executedTrades(rows, { idOfEspn: e => byEspn.get(S(e)) ?? null });
    const executed = new Set(rows.filter(x => x.execution_type === 'PROCESS' && x.status === 'EXECUTED').map(x => x.tx_id)).size;
    if (executed > 0 && !trades.length) {
      return { status: 'ledger_missing', sold: new Set(), unmapped, reason: `${executed} executed trades on file but none could be read` };
    }
    const mem = tradeMemory({ now, trades, valueAt: () => null }, { me, valueNow: () => null, positionOf: () => null });
    return { status: 'ok', sold: new Set([...mem.sold.keys()].map(S)), unmapped };
  } catch (e) {
    return { status: 'error', sold: new Set(), unmapped: 0, reason: `trade ledger read failed: ${e?.message ?? String(e)}` };
  }
}

let plansCache = { file: null, mtime: null, size: null, doc: null };
/** The served War Room plans (read-only, cached by mtime), or null when there is no file. */
function servedPlans(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (plansCache.file === file && plansCache.mtime === st.mtimeMs && plansCache.size === st.size) return plansCache.doc;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  plansCache = { file, mtime: st.mtimeMs, size: st.size, doc };
  return doc;
}

/**
 * The blue-chip score (PLAYER-SCORE, people/player-score.js) per player for one league, as the War Room
 * last served it (entry.blue_chips). -> { status, byId: Map id -> score }. No file, no entry or the board
 * off: an empty map, so every get is unscored and the gate fails closed on it (coordinator decision 5).
 */
export function servedScores(leagueId, { plansPath = warRoomPlansPath() } = {}) {
  const doc = servedPlans(path.resolve(plansPath));
  if (!doc) return { status: 'no_plans', byId: new Map() };
  const entry = (doc.leagues ?? []).find(l => S(l.league) === S(leagueId));
  const bc = entry?.blue_chips;
  if (!entry || bc?.status !== 'ok') return { status: entry ? 'board_off' : 'no_entry', byId: new Map() };
  const byId = new Map();
  for (const r of bc.value?.rows ?? []) if (Number.isFinite(Number(r.score))) byId.set(S(r.player), Number(r.score));
  return { status: 'ok', byId };
}

/** The objectives file: the producer's GRIDIRON_WARROOM_OBJECTIVES, else objectives.json next to the plans. */
const objectivesFile = (plansPath, env) =>
  env.GRIDIRON_WARROOM_OBJECTIVES?.trim() || path.join(path.dirname(path.resolve(plansPath)), 'objectives.json');

/** One league's row of the objectives file, or null (absent file or no row). A file that does not parse throws. */
function objectiveRow(leagueId, { plansPath, env }) {
  const file = objectivesFile(plansPath, env);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = parsed?.[S(leagueId)];
  return raw && typeof raw === 'object' ? raw : null;
}

/**
 * Nick's own untouchables for this league from the objectives file (the producer's
 * GRIDIRON_WARROOM_OBJECTIVES, else objectives.json next to the plans). Absent file -> none.
 * A file that does not parse throws: the gate fails closed on it.
 */
export function objectiveUntouchables(leagueId, { plansPath = warRoomPlansPath(), env = process.env } = {}) {
  const raw = objectiveRow(leagueId, { plansPath, env });
  return Array.isArray(raw?.untouchables) ? raw.untouchables.map(S) : [];
}

/* ------------------------------------------------------------------ PER-LEAGUE RULES (plan item 36) */

/**
 * Nick's rules, per league: each league's objectives row may carry a `rules` block
 *   { never_give: id[], never_get: id[], floor: score, overpay_cap: fraction, depth_premium_max: fraction }
 * so leagues 1, 2, 3 and 5 get the same protections with their own player ids. Read only with
 * GRIDIRON_PER_LEAGUE_RULES=1 (off: every league runs on the pins and the constants below, as before).
 *
 * TIGHTEN-ONLY. A block may add ids and raise the bar; it can never lower one:
 *   - the pinned ids (PINNED_NEVER_GIVE, PINNED_NEVER_GET) hold in every league whatever the block says;
 *   - floor >= 83 (Blue chip), overpay_cap <= 0, 0 <= depth_premium_max <= +12%.
 * A value that would loosen a rule, or does not read, is an error, never a silent clamp: the gate and the
 * planner fail closed on it (nothing is served for that league until the block is fixed). No block, or no
 * row, is league 4's rules exactly (leagueRuleDefaults).
 */
export const PER_LEAGUE_RULES_ENV = 'GRIDIRON_PER_LEAGUE_RULES';
export const perLeagueRulesOn = (env = process.env) => env?.[PER_LEAGUE_RULES_ENV] === '1';
/** League 4's rules, the default for any league without a block (a function: search.js is mid-cycle at import). */
export const leagueRuleDefaults = () => ({ floor: BLUE_CHIP_SCORE, overpay_cap: 0, depth_premium_max: DEPTH_PREMIUM_MAX });
const RULE_KEYS = Object.freeze(['never_give', 'never_get', 'floor', 'overpay_cap', 'depth_premium_max']);
const PLAYER_ID = /^[1-9][0-9]*$/;

/**
 * One league's `rules` block, resolved tighten-only. -> { never_give: string[], never_get: string[],
 * floor, overpay_cap, depth_premium_max, source: 'default' | 'objectives', errors: string[] }.
 * errors non-empty -> the caller fails closed. never_give / never_get are the block's ids (the pins are
 * added by the callers, as for league 4).
 */
export function resolveLeagueRules(block) {
  const out = { never_give: [], never_get: [], ...leagueRuleDefaults(), source: 'default', errors: [] };
  if (block == null) return out;
  if (typeof block !== 'object' || Array.isArray(block)) { out.errors.push('rules block is not an object'); return out; }
  out.source = 'objectives';
  for (const k of Object.keys(block)) if (!RULE_KEYS.includes(k)) out.errors.push(`unknown rule "${k}"`);
  for (const k of ['never_give', 'never_get']) {
    if (block[k] == null) continue;
    if (!Array.isArray(block[k])) { out.errors.push(`${k} is not a list of player ids`); continue; }
    const ids = block[k].map(S);
    const bad = ids.filter(id => !PLAYER_ID.test(id));
    if (bad.length) out.errors.push(`${k} has ${bad.length} value(s) that are not player ids`);
    out[k] = [...new Set(ids.filter(id => PLAYER_ID.test(id)))];
  }
  const num = (k, ok, why) => {
    if (block[k] == null) return;
    const v = typeof block[k] === 'number' ? block[k] : NaN;
    if (!Number.isFinite(v)) out.errors.push(`${k} is not a number`);
    else if (!ok(v)) out.errors.push(`${k} ${v} ${why}`);
    else out[k] = v;
  };
  num('floor', v => v >= BLUE_CHIP_SCORE && v <= 100, `would lower the Blue chip floor (${BLUE_CHIP_SCORE}-100 only)`);
  num('overpay_cap', v => v <= 0 && v >= -1, 'would allow an overpay (0 or below only)');
  num('depth_premium_max', v => v >= 0 && v <= DEPTH_PREMIUM_MAX, `would widen the depth-only premium (0 to +${DEPTH_PREMIUM_MAX * 100}% only)`);
  return out;
}

/**
 * The league's rules from the objectives file, resolved (resolveLeagueRules) plus the row's untouchables.
 * A file that does not parse throws: the gate fails closed on it.
 */
export function leagueRulesOf(leagueId, { plansPath = warRoomPlansPath(), env = process.env } = {}) {
  const raw = objectiveRow(leagueId, { plansPath, env });
  return { ...resolveLeagueRules(raw?.rules), untouchables: Array.isArray(raw?.untouchables) ? raw.untouchables.map(S) : [] };
}

/* ------------------------------------------------------------------ the gate */

/**
 * The ONE rule gate. Every trade-suggesting surface builds one per request and passes its list
 * through gate.filter before anything is returned. The rules apply to Nick's team only (the league's
 * my_team_id): from Nick's side when the suggestions are for his team, and from his side too when
 * another team's suggestion names him as the partner.
 *
 * db: { row, rows } (server/db/index.js). teamId: the team the suggestions are for (default Nick's).
 * -> { applies, me, rules, check(t), filter(list, sidesOf) -> { kept, dropped_by_rule, needs_nick_ok }, ok }
 *    sidesOf(item) -> { give, get, partner?, premium?, move_id? } from the suggesting team's side.
 * AJ-PICK: a suggestion that gives A.J. Brown for one of Nick's picks passes the rules but needs his OK;
 * it is kept only when it names a move_id Nick confirmed (aj.confirm), else dropped and counted in
 * needs_nick_ok (and dropped_by_rule). Only the War Room deck shows it unconfirmed, as a "Needs your OK" card.
 */
export function ruleGate(db, { leagueId, teamId = null, plansPath = warRoomPlansPath(), env = process.env, now = Date.now() } = {}) {
  const nick = nickTeamOf(db, leagueId);
  if (!nick) return passThrough();
  const me = nick.me;
  const closed = [];
  let extra = [];
  // PER-LEAGUE RULES (flag GRIDIRON_PER_LEAGUE_RULES=1): the league's rules block; off, today's constants.
  let lr = null;
  if (perLeagueRulesOn(env)) {
    try {
      lr = leagueRulesOf(leagueId, { plansPath, env });
      extra = [...lr.untouchables, ...lr.never_give];
      if (lr.errors.length) closed.push(`league ${leagueId} rules block invalid (${lr.errors.join('; ')})`);
    } catch (e) { closed.push(`objectives file unreadable (${e.message})`); }
  } else {
    try { extra = objectiveUntouchables(leagueId, { plansPath, env }); } catch (e) { closed.push(`objectives file unreadable (${e.message})`); }
  }
  const fc = fcValues(db);
  const sold = soldThisSeason(db, { leagueId, season: nick.season, me, now });
  if (sold.status === 'ledger_missing' || sold.status === 'error') closed.push(sold.reason);
  let scores;
  try { scores = servedScores(leagueId, { plansPath }); } catch (e) { scores = { status: 'error', byId: new Map() }; closed.push(`served plans unreadable (${e.message})`); }
  // AJ-PICK: Nick's picks for A.J. Brown and the cards he OK'd. Unreadable -> no picks (277 stays locked).
  let aj = { status: 'off', allow: new Set(), confirmed: new Set() };
  if (ajPickOn(env)) {
    try { aj = ajState(db, leagueId); } catch (e) { aj = { status: 'error', allow: new Set(), confirmed: new Set(), reason: e.message }; }
  }
  const rules = {
    neverGive: new Set([...PINNED_NEVER_GIVE, ...extra]),
    neverGet: new Set([...PINNED_NEVER_GET, ...(lr?.never_get ?? [])]),
    sold: sold.sold,
    fc: fc.byId,
    scoreOf: id => scores.byId.get(S(id)) ?? null,
    closed: closed.length ? closed.join('; ') : null,
    ajAllow: aj.allow,
    sources: { fc_value: fc.status, ledger: sold.status, scores: scores.status, aj_pick: aj.status },
    ...(lr ? { floor: lr.floor, overpayCap: lr.overpay_cap, depthPremiumMax: lr.depth_premium_max,
      league_rules: { source: lr.errors.length ? 'invalid' : lr.source } } : {}),
  };
  const forNick = teamId == null || S(teamId) === me;
  const check = t => ruleVerdict(rules, t);
  const filter = (list, sidesOf) => {
    const kept = [];
    let dropped = 0, needsOk = 0;
    for (const item of list ?? []) {
      const s = sidesOf(item);
      const nickSide = forNick ? { give: s.give, get: s.get, premium: s.premium }
        : s.partner != null && S(s.partner) === me ? { give: s.get, get: s.give, premium: null } : null;
      const v = nickSide ? check(nickSide) : null;
      if (v && v.ok && v.requires_nick_confirm && !(s.move_id != null && aj.confirmed.has(S(s.move_id)))) { dropped++; needsOk++; continue; }
      if (!v || v.ok) kept.push(item);
      else dropped++;
    }
    return { kept, dropped_by_rule: dropped, needs_nick_ok: needsOk };
  };
  /** One package from the suggesting team's side: whether it may be shown (moveId: the card it is, for AJ-PICK). */
  const ok = (give, get, partner = null, premium = null, { moveId = null } = {}) =>
    filter([0], () => ({ give: idsOf(give), get: idsOf(get), partner, premium, move_id: moveId })).kept.length === 1;
  return { applies: true, me, forNick, rules, check, filter, ok, aj };
}

function passThrough() {
  return { applies: false, me: null, forNick: false, rules: null,
    check: () => ({ ok: true, reasons: [], overpay: null, requires_nick_confirm: false }),
    filter: list => ({ kept: [...(list ?? [])], dropped_by_rule: 0, needs_nick_ok: 0 }), ok: () => true, aj: null };
}

/** Ids out of a mixed list: numbers, strings, or objects carrying id / player_id / playerId. */
export const idsOf = list => (list ?? []).map(x => (x != null && typeof x === 'object' ? x.id ?? x.player_id ?? x.playerId : x))
  .filter(x => x != null).map(S);

/**
 * Coach's free-text drafts (warroom_draft_message) carry names, not ids, and no league. A draft that
 * names any player one of Nick's hard rules keeps out of a trade in any of his leagues (never give,
 * never get, sold this season, his objectives' untouchables) is dropped. Names are read from the
 * players table at run time. -> the blocked player ids the text names ([] = the draft may be shown).
 */
export function draftNamesBlocked(db, text, { plansPath = warRoomPlansPath(), env = process.env } = {}) {
  const norm = x => String(x ?? '').toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim();
  const t = ` ${norm(text)} `;
  if (!t.trim()) return [];
  const leagues = db.rows(`SELECT id FROM leagues WHERE my_team_id IS NOT NULL AND my_team_id != ''`);
  const ids = new Set();
  for (const l of leagues) {
    const g = ruleGate(db, { leagueId: l.id, plansPath, env });
    if (!g.applies) continue;
    for (const set of [g.rules.neverGive, g.rules.neverGet, g.rules.sold]) for (const id of set) ids.add(S(id));
  }
  const hits = [];
  for (const id of ids) {
    const nm = db.row('SELECT name FROM players WHERE id = ?', Number(id))?.name;
    const n = norm(nm);
    if (n && t.includes(` ${n} `)) hits.push(id);
  }
  return hits;
}
