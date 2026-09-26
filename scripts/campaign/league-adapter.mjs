/**
 * The real adapter for server/services/campaign/planner.js: one league's state
 * read from the DB and the season simulator. Runs in the producer process only
 * (scripts/campaign/produce-plans.mjs), never on a request.
 *
 *   world(seed)       season-sim.js#tradeImpactWorld (the fast rescore, RL-19-2)
 *                     under that seed; the planning seed is tradeImpactSeed(lg),
 *                     the same dice every other title-odds surface uses
 *   priceStep         today's model: counterparty-pricing.js#readDeal ->
 *                     p-yes.js#pYesFor (LIVE-BLEND: baseline x clone blend by default, GRIDIRON_PYES_BLEND=0 baseline; edge assumed
 *                     passed for every step, as in the ACQ-FLIP prototype)
 *   managers          counterparty layer (activity, needs) + timing read + chat labels
 *   finderBest        the Trade Lab finder's best single offer (title-odds-trades.js x
 *                     findTrades acceptance midpoint), the study's baseline; off with --no-finder
 *   sanity            composed rescore == served tradeImpact on one one-for-one deal
 */
import { chatLabels } from '../../server/services/campaign/partners.js';
import { resolveUntouchables, untouchableIds } from '../../server/services/people/profile-reader.js';
import { PREVIEW_ENV } from '../../server/services/preview-mode.js';
import { tradeBlocks } from '../../server/services/espn-trade-block.js';
import { tradeBlockRead, chatInterestRead } from '../../server/services/campaign/his-side.js';
import { readChatTradeInterest } from '../../server/services/people/chat-trade-interest.js';
import { loveEnabled } from '../../server/services/campaign/love.js';
import { readLoveInputs } from '../../server/services/campaign/love-inputs.js';
import { sellHighEnabled } from '../../server/services/campaign/sell-high.js';
import { readSellHighInputs } from '../../server/services/campaign/sell-high-inputs.js';
import { buyLowEnabled } from '../../server/services/campaign/buy-low.js';
import { readBuyLow } from '../../server/services/campaign/buy-low-inputs.js';
import { buildBoard, playerScoreFlag, WEIGHTS as SCORE_WEIGHTS, LABEL_NAMES } from '../../server/services/people/player-score.js';
import { fpRosFor, syncIfStale } from '../../server/services/people/fantasypros-ros.js';
import { executedTrades } from '../../server/services/campaign/trade-memory.js';
import { fcValues, fcValueOf, fcFormatValues } from '../../server/services/fc-value.js';
import { negotiatorDefaultsOn, coolOff } from '../../server/services/campaign/negotiator-defaults.js';
import { draftCapitalGuarded, draftIdMapEnabled } from '../../server/services/campaign/draft-capital.js';
import { searchWideFlag, CLAIM_POOL_SIZE } from '../../server/services/campaign/search-wide.js';

/**
 * PRODUCER-FAST: each week's starters picked once instead of once per run
 * (season-sim.js#teamPointsFast, the same doubles) and the rescore cache keyed by
 * a content hash of the world. Default off; on with GRIDIRON_PRODUCER_FAST=1 or
 * under preview mode (preview-mode.js); =0 vetoes preview. Off, the adapter is exactly as before.
 */
export const PRODUCER_FAST_ENV = 'GRIDIRON_PRODUCER_FAST';
export const producerFastEnabled = (env = process.env) => env[PRODUCER_FAST_ENV] === '1'
  || (env[PRODUCER_FAST_ENV] !== '0' && env[PREVIEW_ENV] === '1');

const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);

/** Free agents: unrostered, available, scored positions with a positive ros_ppg, best first. */
export function freeAgentPool(assets, rostered) {
  return [...assets.values()].filter(p => !rostered.has(p.id) && SCORED.has(p.position) && p.available !== false
    && Number.isFinite(p.ros_ppg) && p.ros_ppg > 0).sort((a, b) => b.ros_ppg - a.ros_ppg);
}
/** The engagement field LIVING-01a writes (engine_state; FIELD-REGISTRY `activity.manager`). */
export const ACTIVITY_FIELD = 'activity.manager';
const LIVING01A_FLAG = 'GRIDIRON_LIVING01A_ENABLED';

/**
 * Who is checked out, per team: the latest `activity.manager` row wins (state + P(checked out));
 * a team with no row falls back to the timing read (present, zero actions), labelled as such; a team
 * with neither gets no entry (unknown, never "engaged").
 * rows: [{ entity_id: '<league>:<team>', value (JSON text), lane }] newest first; timing: Map team -> timingRead entry.
 */
export function activityReads(rows, timing, leagueId) {
  const out = new Map();
  const prefix = `${leagueId}:`;
  for (const r of rows ?? []) {
    const id = String(r.entity_id);
    if (!id.startsWith(prefix)) continue;
    const team = id.slice(prefix.length);
    if (out.has(team)) continue;
    let v = null;
    try { v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value; } catch (e) {
      throw new Error(`${ACTIVITY_FIELD} row for team ${team} is not JSON: ${e.message}`);
    }
    const p = Number.isFinite(v?.probs?.checked_out) ? v.probs.checked_out : null;
    out.set(team, { checked_out: v?.state === 'checked_out', source: ACTIVITY_FIELD, p, lane: r.lane ?? null });
  }
  for (const [team, tm] of timing ?? []) {
    const t = String(team);
    if (out.has(t) || tm?.read_state !== 'present') continue;
    out.set(t, { checked_out: tm.actions_n === 0, source: 'timing read', p: null, lane: null });
  }
  return out;
}

/** activity.manager rows for one league, newest first: live lane, plus shadow when the flag or preview is on. */
/** Older than this, last week's margin is not last week's any more: no cool-off from it (hand-set). */
export const MARGIN_MAX_AGE_DAYS = 7;

/**
 * NEGOTIATOR-DEFAULTS: last week's scoring margin per roster (manager_signals), for the cool-off.
 * Only rows computed within MARGIN_MAX_AGE_DAYS of `now`; an older margin starts no cool-off.
 */
export function lastWeekMargins(svc, leagueId, now) {
  const has = svc.db.row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'manager_signals'`);
  if (!has) return new Map();
  const since = new Date(now - MARGIN_MAX_AGE_DAYS * DAY).toISOString().replace('T', ' ').slice(0, 19);
  return new Map(svc.db.rows(`SELECT roster_id, value FROM manager_signals
      WHERE league_id = ? AND metric = 'last_week_margin' AND computed_at >= ?`, leagueId, since)
    .filter(r => Number.isFinite(Number(r.value))).map(r => [String(r.roster_id), Number(r.value)]));
}

function activityRows(svc, leagueId, env = process.env) {
  const has = svc.db.row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'engine_state'`);
  if (!has) return [];
  const lanes = env[LIVING01A_FLAG] === '1' || env[PREVIEW_ENV] === '1' ? ['live', 'shadow'] : ['live'];
  return svc.db.rows(`SELECT entity_id, value, lane FROM engine_state
    WHERE field = ? AND league_id = ? AND lane IN (${lanes.map(() => '?').join(', ')})
    ORDER BY CASE lane WHEN 'live' THEN 0 ELSE 1 END, as_of DESC, id DESC`, ACTIVITY_FIELD, Number(leagueId), ...lanes);
}
const FLEX = { FLEX: ['RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['RB', 'WR'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], OP: ['QB', 'RB', 'WR', 'TE'] };
const DAY = 864e5;

export async function loadServices({ env = process.env } = {}) {
  const db = await import('../../server/db/index.js');
  // PLAYER-SCORE: refresh the FantasyPros rest-of-season cache (a read-only GET of the public
  // DynastyProcess file, at most once a day) only when the board is on. A failure is carried to
  // the board as its reason, never thrown.
  const fpSync = playerScoreFlag(env) !== 'off' ? await syncIfStale(db) : { status: 'off' };
  return {
    db, fpSync,
    sim: await import('../../server/services/season-sim.js'),
    cp: await import('../../server/services/counterparty-pricing.js'),
    pyes: await import('../../server/services/p-yes.js'),
    engine: await import('../../server/services/trade-engine.js'),
    tactics: await import('../../server/services/trade-tactics.js'),
    week: await import('../../server/services/league-week.js'),
    horizon: await import('../../server/services/trade-horizon.js'),
    titleOdds: await import('../../server/services/title-odds-trades.js'),
    identity: await import('../../server/services/manager-identity.js'),
    format: await import('../../server/services/format.js'),
    radar: await import('../../server/services/opportunity-radar.js'),
  };
}

/**
 * The Trade Lab finder's best single offer: served title-odds deals x the finder's own
 * acceptance midpoint, highest expected first. The one rule for the producer's finder
 * baseline (finderBest below) and SOURCE-TABLES' finder arm
 * (scripts/eval/produce-source-tables.mjs). -> { expected, se, n, move: { partner, give, get } } | { error }
 */
export function pickFinderBest(servedDeals, foundDeals) {
  const same = (a, b) => a.map(p => p.id).join() === b.map(p => p.id).join();
  let best = null, n = 0;
  for (const d of servedDeals ?? []) {
    const f = (foundDeals ?? []).find(x => x.partner_id === d.partner_id && same(x.i_give, d.i_give) && same(x.i_get, d.i_get));
    const p = f?.acceptance?.band?.mid;
    if (!Number.isFinite(p) || !Number.isFinite(d.title_delta)) continue;
    n++;
    const e = { expected: p * d.title_delta, se: Number.isFinite(d.title_delta_se) ? p * d.title_delta_se : null,
      move: { partner: String(d.partner_id), give: d.i_give.map(x => String(x.id)), get: d.i_get.map(x => String(x.id)) } };
    if (!best || e.expected > best.expected) best = e;
  }
  return best ? { ...best, n } : { error: `no served deal carried a finder acceptance price (${(servedDeals ?? []).length} served)` };
}

/** Nick's starters by rest-of-season rate: dedicated slots first, then flex (mirrors lineupPoints). */
export function startersOf(players, slots) {
  const pool = players.filter(p => SCORED.has(p.position)).sort((a, b) => (b.ros_ppg ?? 0) - (a.ros_ppg ?? 0));
  const used = new Set();
  for (const s of slots) {
    if (!SCORED.has(s)) continue;
    const pick = pool.find(p => !used.has(p.id) && p.position === s);
    if (pick) used.add(pick.id);
  }
  for (const s of slots) {
    const ok = FLEX[s];
    if (!ok) continue;
    const pick = pool.find(p => !used.has(p.id) && ok.includes(p.position));
    if (pick) used.add(pick.id);
  }
  return used;
}

/** ESPN's trade deadline in ms (TM-34 deadline mode reads the exact time); null when the settings carry none. */
export function deadlineMs(payload) {
  const ms = Number(payload?.settings?.tradeSettings?.deadlineDate);
  return ms > 0 ? ms : null;
}

/** The league's trade review window in hours (ESPN revisionHours); null when the settings carry none. */
export function reviewHours(payload) {
  const h = payload?.settings?.tradeSettings?.revisionHours;
  return Number.isFinite(h) && h >= 0 ? h : null;
}

/** The trade deadline as a week, from ESPN's deadlineDate and the NFL schedule; null when unknown. */
function deadlineWeek(svc, lg, payload) {
  const ms = deadlineMs(payload);
  if (ms == null) return null;
  const day = new Date(ms).toISOString().slice(0, 10);
  const r = svc.db.row(`SELECT MAX(week) AS w FROM (SELECT week, MIN(date) AS start FROM schedule_games
                        WHERE season = ? GROUP BY week) WHERE start <= ?`, lg.season, day);
  return Number.isInteger(r?.w) ? r.w : null;
}

function daysLeftInWeek(svc, lg, week, now) {
  const r = svc.db.row('SELECT MIN(date) AS d FROM schedule_games WHERE season = ? AND week = ?', lg.season, week + 1);
  const t = Date.parse(r?.d ?? '');
  return Number.isFinite(t) ? Math.max(0, Math.floor((t - now) / DAY)) : 7;
}

const text = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);

/**
 * TEAM-NAMES: who each roster is, read at run time from the league payload (never committed):
 * { [roster_id]: { name?: ESPN team name, manager?: who Nick knows him as } }. The manager is the
 * trusted chat identity's name first (the name Nick's own manager_notes are keyed by), else the
 * ESPN owner's first name, else his display name. A roster with neither is left out, so the page
 * says 'Team N' for it.
 */
export function teamNames(payload, chatNames = new Map()) {
  const members = new Map((payload?.members ?? []).map(m => [String(m?.id), m]));
  const out = {};
  for (const t of payload?.teams ?? []) {
    if (t?.id == null) continue;
    const owner = members.get(String(t.primaryOwner ?? t.owners?.[0]));
    const name = text(t.name) ?? text(`${t.location ?? ''} ${t.nickname ?? ''}`);
    const manager = text(chatNames.get(String(t.id))) ?? text(owner?.firstName) ?? text(owner?.displayName);
    if (name || manager) out[String(t.id)] = { ...(name ? { name } : {}), ...(manager ? { manager } : {}) };
  }
  return out;
}

/**
 * Offers Nick sent each manager in the last 7 days: ESPN's own proposals, plus
 * every "I sent it" in `trade_outcomes` (sent_at IS NOT NULL; War Room and
 * TradeCard taps alike) that the settle job has not matched to one of those
 * proposals, so a tapped offer ESPN also shows counts once.
 */
export function sentThisWeek(svc, leagueId, season, me, now) {
  const out = new Map();
  const rows = svc.db.rows(`SELECT tx_id, items_json, proposed_at FROM league_transactions_raw
                            WHERE league_id = ? AND season = ? AND type = 'TRADE_PROPOSAL' AND team_id = ?
                              AND (execution_type IS NULL OR execution_type NOT IN ('CANCEL', 'PROCESS'))`,
  leagueId, season, Number(me));
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.tx_id)) continue;
    seen.add(r.tx_id);
    const at = svc.tactics.toTime(r.proposed_at);
    if (at == null || now - at > 7 * DAY) continue;
    let items;
    try { items = JSON.parse(r.items_json || '[]'); } catch (e) { throw new Error(`league ${leagueId} tx ${r.tx_id}: items_json unreadable (${e.message})`); }
    const other = new Set(items.flatMap(i => [i.fromTeamId, i.toTeamId]).filter(t => t != null && t > 0 && String(t) !== String(me)).map(String));
    for (const t of other) out.set(t, (out.get(t) ?? 0) + 1);
  }
  const sentCols = svc.db.rows('PRAGMA table_info(trade_outcomes)').map(c => c.name);
  if (!sentCols.includes('sent_at')) return out;
  const tapped = svc.db.rows(`SELECT counterparty_team_id, sent_at, matched_tx_id FROM trade_outcomes
                              WHERE league_id = ? AND season = ? AND sent_at IS NOT NULL AND counterparty_team_id IS NOT NULL`,
  leagueId, season);
  for (const o of tapped) {
    if (o.matched_tx_id != null && seen.has(String(o.matched_tx_id))) continue;
    const at = Date.parse(o.sent_at);
    if (!Number.isFinite(at) || now - at > 7 * DAY) continue;
    out.set(String(o.counterparty_team_id), (out.get(String(o.counterparty_team_id)) ?? 0) + 1);
  }
  return out;
}

const hasTable = (svc, name) => !!svc.db.row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

/**
 * TRADE-MEMORY (ONE-PLAN 4c): this season's executed trades for the planner, with the FantasyCalc
 * price on a given day (dynasty_value_history: the last capture on or before that day, this league's
 * format). assets: the sim's asset universe (Map id -> { espn_id }). No transaction table -> null
 * (the planner then says 'no_ledger'); no history table -> every past price is unknown, so nothing
 * Nick sold qualifies as a buy-back and floors fall back to today's value (labelled 'value_now').
 */
export function tradeLedger(svc, { leagueId, season, formatKey, assets, now }) {
  if (!hasTable(svc, 'league_transactions_raw')) return null;
  const rows = svc.db.rows(`SELECT tx_id, type, status, execution_type, items_json, proposed_at, processed_at
    FROM league_transactions_raw WHERE league_id = ? AND season = ? AND type = 'TRADE_ACCEPT'`, leagueId, season);
  const byEspn = new Map();
  for (const a of assets.values()) if (a?.espn_id != null) byEspn.set(String(a.espn_id), a.id);
  const { trades, unmapped } = executedTrades(rows, { idOfEspn: e => byEspn.get(String(e)) ?? null });
  const history = formatKey != null && hasTable(svc, 'dynasty_value_history');
  const valueAt = (id, at) => {
    if (!history) return null;
    const day = new Date(at).toISOString().slice(0, 10);
    const r = svc.db.row(`SELECT value FROM dynasty_value_history WHERE format_key = ? AND player_id = ? AND captured_on <= ?
      ORDER BY captured_on DESC LIMIT 1`, formatKey, Number(id), day);
    return Number.isFinite(r?.value) ? r.value : null;
  };
  return { now, trades, unmapped, valueAt, history };
}

/**
 * RADAR-WIRE reads (why-now.js#applyWhyNow). The trend is FantasyCalc's own 30-day move for this
 * league's format (dynasty_values via fc-value.js#fcFormatValues), next to that format's value.
 * historyDays: capture days in dynasty_value_history for this format (the trend is a watch label below 7).
 * News: typed signals (nfl_news_signals, players.id as text); alive = any signal written in the window.
 * A missing table reads as no data; the served label says which input was missing.
 */
export function radarReads(svc, { formatKey = null, windowHours = 48 } = {}) {
  const history = formatKey != null && hasTable(svc, 'dynasty_value_history');
  const news = hasTable(svc, 'nfl_news_signals');
  const since = now => new Date(now - windowHours * 3600e3).toISOString();
  // #405 finding 2: value and trend from THIS league's format (fc-value.js#fcFormatValues), the same
  // format dynasty_value_history is counted in; never player_metrics' league-1-format set.
  let fmt = null;
  const format = () => (fmt ??= fcFormatValues(svc.db, formatKey));
  return {
    fcFormatKey: formatKey,
    fcTrendOf: id => {
      const r = format().byId.get(String(id));
      return r && Number.isFinite(r.value) && Number.isFinite(r.trend30) ? { value: r.value, trend30: r.trend30 } : null;
    },
    fcHistoryDays: () => (history
      ? svc.db.row('SELECT COUNT(DISTINCT captured_on) AS n FROM dynasty_value_history WHERE format_key = ?', formatKey)?.n ?? 0 : 0),
    newsOf: (id, now) => (news ? svc.db.rows(`SELECT signal_type, status, unavailable_probability, role_delta, published_at
      FROM nfl_news_signals WHERE player_id = ? AND datetime(published_at) >= datetime(?)
      ORDER BY published_at DESC`, String(id), since(now)) : []),
    newsAlive: now => (news ? !!svc.db.row('SELECT 1 AS ok FROM nfl_news_signals WHERE datetime(created_at) >= datetime(?) LIMIT 1', since(now)) : false),
  };
}

/** Executed TRADE_ACCEPT rows this season in league_transactions_raw (0 when the table is missing). */
/**
 * SEARCH-WIDE (#406 finding 1): this league's processed waiver claims this season, all teams:
 * won = ESPN executed the claim; lost = another team got the player (FAILED_INVALIDPLAYERSOURCE).
 * Other failures (the drop already gone), cancels and pending claims say nothing about competition.
 * No transaction table: null (claims then fail closed).
 */
export function waiverRecord(svc, { leagueId, season }) {
  if (!hasTable(svc, 'league_transactions_raw')) return null;
  const r = svc.db.row(`SELECT SUM(status = 'EXECUTED') AS won, SUM(status = 'FAILED_INVALIDPLAYERSOURCE') AS lost
    FROM league_transactions_raw WHERE league_id = ? AND season = ? AND type = 'WAIVER' AND execution_type = 'PROCESS'`,
  leagueId, season);
  return { won: Number(r?.won ?? 0), lost: Number(r?.lost ?? 0) };
}

export function executedTradeRows(svc, { leagueId, season }) {
  if (!hasTable(svc, 'league_transactions_raw')) return 0;
  return svc.db.row(`SELECT COUNT(DISTINCT tx_id) AS n FROM league_transactions_raw WHERE league_id = ? AND season = ?
    AND type = 'TRADE_ACCEPT' AND execution_type = 'PROCESS' AND status = 'EXECUTED'`, leagueId, season)?.n ?? 0;
}

/**
 * Build the adapter for one league. chat: Map roster -> { profile, negotiation, sentiment: [{ player
 * (name), sentiment_mean, n }], nick } from scripts/campaign/chat-labels.mjs, or null (no chat -> every
 * label 'unknown').
 */
export function buildAdapter(svc, leagueId, { chat = null, now = Date.now(), finder = true, fast = producerFastEnabled(),
  rescoreCache = null, env = process.env, draftIdMap = draftIdMapEnabled(env), love = loveEnabled(env), sellHigh = sellHighEnabled(env), buyLow = buyLowEnabled(env),
  searchWide = searchWideFlag(env) } = {}) {
  // #406 finding 2: SEARCH-WIDE is read ONCE, here, from the env the producer passes; the adapter carries
  // it (adapter.searchWide) and the planner follows the adapter, so the world (claim universe) and the
  // planner can never disagree about the flag.
  const claims = searchWide === 'on';
  const lg = svc.db.row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg) throw new Error(`league ${leagueId} not found`);
  const payload = JSON.parse(lg.payload ?? '{}');
  const me = String(lg.my_team_id);
  const { tradeImpactWorld, tradeImpact, __test: { lineupPoints } } = svc.sim;
  const wBase = tradeImpactWorld(lg, { fastLineups: fast });
  if (wBase.fail) return { fail: String(wBase.fail?.error ?? wBase.fail) };
  // SEARCH-WIDE (GRIDIRON_SEARCH_WIDE=1 only): the top free agents are simulated as the world's universe, so
  // a claim step is priced on the same dice as the trades. That is a different world (season-sim.js:940), so
  // every number moves a little: the reason the flag is off until measured. Off, the world is today's.
  const claimIds = claims
    ? freeAgentPool(wBase.prep.assets, new Set(wBase.prep.teams.flatMap(t => t.players.map(p => p.id)))).slice(0, CLAIM_POOL_SIZE).map(p => p.id)
    : [];
  const w0 = claimIds.length ? tradeImpactWorld(lg, { fastLineups: fast, universe: claimIds, projections: wBase.projections }) : wBase;
  if (w0.fail) return { fail: String(w0.fail?.error ?? w0.fail) };
  const assets = w0.prep.assets;
  const worlds = new Map([[w0.key.seed, w0]]);
  const worldFor = seed => {
    if (!worlds.has(seed)) worlds.set(seed, tradeImpactWorld(lg, { seed, projections: w0.projections, fastLineups: fast, universe: claimIds }));
    return worlds.get(seed);
  };

  const teamPoints = (w, players) => {
    if (fast) return svc.sim.teamPointsFast(w, players);
    const out = new Map();
    // SIM-KDST: the week's K / D/ST points go in as season-sim's own teamPoints passes them.
    for (const [wk, { byRun, expected, kdst }] of w.draws) {
      const arr = new Float64Array(w.runs);
      for (let run = 0; run < w.runs; run++) arr[run] = lineupPoints(players, w.prep.slots, byRun[run], expected, kdst);
      out.set(wk, arr);
    }
    return out;
  };
  const seasonAvg = (pts, runs) => {
    const avg = new Float64Array(runs);
    for (const arr of pts.values()) for (let r = 0; r < runs; r++) avg[r] += arr[r] / pts.size;
    return avg;
  };
  const wrapped = new WeakMap();
  const wrap = w => {
    if (w.fail) return { fail: String(w.fail?.error ?? w.fail) };
    if (!wrapped.has(w)) wrapped.set(w, wrapWorld(w));
    return wrapped.get(w);
  };
  const wrapWorld = w => {
    const baseAvg = seasonAvg(w.points.get(me), w.runs);
    const baseMean = baseAvg.reduce((s, x) => s + x, 0) / w.runs;
    const otherOf = (state, a, b) => b ?? [...state.keys()].find(id => id !== a) ?? w.prep.teams.find(t => t.roster_id !== a).roster_id;
    const rescore = (state, a = me, b = null) => {
      const teams = w.prep.teams.map(t => (state.has(t.roster_id)
        ? { ...t, players: state.get(t.roster_id).map(id => assets.get(id)).filter(Boolean) } : t));
      const points = new Map(w.points);
      for (const t of teams) if (state.has(t.roster_id)) points.set(t.roster_id, teamPoints(w, t.players));
      const other = otherOf(state, a, b);
      // SEARCH-WIDE: name the world's extra free agents (the claim universe), or tradeImpact rebuilds a world
      // without them on every rescore: ~100x slower, and the rebuilt world ignores `state` (delta 0).
      const r = tradeImpact(lg, { myTeamId: a, theirTeamId: other, iGive: [], iGet: [], seed: w.key.seed,
        world: { ...w, prep: { ...w.prep, teams }, points }, universe: w.extras ?? [] });
      if (r.error) throw new Error(r.error);
      if (a === me) {
        const after = state.has(me) ? seasonAvg(points.get(me), w.runs) : baseAvg;
        let s = 0, s2 = 0;
        for (let i = 0; i < w.runs; i++) { const d = after[i] - baseAvg[i]; s += d; s2 += d * d; }
        const m = s / w.runs, se = Math.sqrt(Math.max(0, s2 / w.runs - m * m) / Math.max(1, w.runs - 1));
        Object.assign(r.me, { points_before: baseMean, points_delta: m, points_delta_se: se, points_delta_clears: se > 0 && Math.abs(m) > 2 * se });
      }
      return r;
    };
    const cached = fast && rescoreCache ? rescoreCache.wrap(w, lg, rescore, otherOf) : null;
    return {
      seed: w.key.seed,
      // PLAYOFF-SEEDING (shadow, integration-e): the base season's playoff_path block, which the planner reads
      // as W.base (planner.js#playoffPathFor). Only the block is exposed; flag off, the key is absent.
      ...(w.base?.playoff_path ? { base: { playoff_path: w.base.playoff_path } } : {}),
      rescore: cached ? (state, a = me, b = null) => cached(state, a, b) : rescore,
      weekly(ids) {
        const pts = teamPoints(w, ids.map(id => assets.get(id)).filter(Boolean));
        return [...pts.entries()].sort((x, y) => x[0] - y[0]).map(([week, arr]) => ({ week, samples: Array.from(arr) }));
      },
    };
  };

  const rosters = new Map(w0.prep.teams.map(t => [t.roster_id, t.players.map(p => p.id)]));
  const players = new Map();
  const slim = id => { const p = assets.get(id); return { id, name: p?.name, position: p?.position, value: p?.value }; };
  // FC-VALUE (integration-8): Nick's rules price on FantasyCalc value through the one reader
  // (server/services/fc-value.js). No fc_value row -> value null: never given, got or flipped (fail closed).
  // market_value keeps the engine's format price for trade memory, whose trade-day prices are on that scale.
  const fc = fcValues(svc.db);
  const addPlayer = id => {
    const p = assets.get(id);
    if (!p) return;
    const fcv = fcValueOf(fc, id);
    players.set(id, { id, name: p.name, position: p.position, value: fcv, market_value: Math.max(0, Number(p.value) || 0),
      ros_ppg: p.ros_ppg, injury: p.injury, bye: p.bye, trend_kind: p.trend_kind, available: p.available,
      espn_id: p.espn_id ?? null, team_abbr: p.team_abbr ?? null, ros_basis: p.ros_basis ?? null });
  };
  for (const ids of rosters.values()) ids.forEach(addPlayer);
  // SEARCH-WIDE: a claimable free agent is a player a step can name, so he is in players (and names).
  claimIds.forEach(addPlayer);
  const rostered = new Set([...rosters.values()].flat());
  const freeAgents = freeAgentPool(assets, rostered).slice(0, 40)
    .map(p => ({ id: p.id, name: p.name, position: p.position, ros_ppg: p.ros_ppg }));

  const nameToId = name => [...players.values()].find(p => p.name === name)?.id ?? null;
  const week = svc.week.leagueCurrentWeek(lg);
  const season = lg.season ?? payload.seasonId;
  // NEGOTIATOR-DEFAULTS (flag, default off): no post-loss "tilt window". His loss no longer raises
  // P(yes); it means a day to cool off, then a fair offer (coolOff on the send window below).
  const ND = negotiatorDefaultsOn(env);
  const layer = svc.cp.counterpartyLayer(leagueId, { season, week, ...(ND ? { zero: ['recency_post_loss'] } : {}) });
  const margins = ND ? lastWeekMargins(svc, leagueId, now) : new Map();
  const timing = svc.tactics.timingRead(leagueId, { season });
  const blocked = new Set(svc.db.rows(`SELECT roster_id FROM manager_profiles WHERE league_id = ? AND tradeability = 'never'`, leagueId)
    .map(r => String(r.roster_id)));
  const sent = sentThisWeek(svc, leagueId, season, me, now);
  const titleByTeam = new Map((w0.base?.teams ?? []).map(t => [String(t.roster_id), t.title_odds]));
  const activity = activityReads(activityRows(svc, leagueId), timing, leagueId);
  const managers = new Map();
  // Nick's own notes (the one reader, keyed by his roster like everyone else's): his protected players.
  const myNick = resolveUntouchables(chat?.get(me)?.nick ?? null, (rosters.get(me) ?? []).map(id => players.get(id)).filter(Boolean));
  for (const t of rosters.keys()) {
    if (t === me) continue;
    const m = layer.get(t) ?? null;
    const tm = timing.get(t) ?? null;
    const send0 = svc.tactics.sendWindow(tm, { now });
    const send = ND ? coolOff(send0, { margin: margins.get(String(t)) ?? null, now }) : send0;
    managers.set(t, {
      receptiveness: m?.receptiveness ?? null, tier: m?.tier ?? null, needs: m?.needs ?? null,
      blocked: blocked.has(t),
      checked_out: activity.get(String(t))?.checked_out ?? false,
      checked_out_source: activity.get(String(t))?.source ?? null,
      p_checked_out: activity.get(String(t))?.p ?? null,
      // TM-34: his last own move in the league (timing read), for deadline mode's who-goes-quiet read.
      last_action_at: tm?.last_action_at ?? null,
      title_now: titleByTeam.get(t) ?? null,
      sent_this_week: sent.get(t) ?? 0,
      send_when: send,
      // Nick's block (the one reader); 'untouchable: <player>' notes resolved against this roster's players.
      nick: resolveUntouchables(chat?.get(t)?.nick ?? null, (rosters.get(t) ?? []).map(id => players.get(id)).filter(Boolean)),
      chat: chat?.has(t) ? chatLabels({ ...chat.get(t),
        sentiment: (chat.get(t).sentiment ?? []).map(x => ({ ...x, player: nameToId(x.player) ?? x.player })) }) : chatLabels(),
    });
  }

  // PYES-ONE: P(yes) comes from p-yes.js, the module Trade Lab reads too. Flag off it is the clone
  // band exactly as before; flag on, the E1 activity baseline per partner (table read once per build).
  const py = svc.pyes.pYesFlag();
  const pyTable = py.on ? svc.pyes.pYesTable(svc.db.db, leagueId, [...rosters.keys()].filter(t => t !== me), { now }) : null;
  const priceStep = (team, theyGive, theyGet) => {
    const m = layer.get(String(team)) ?? null;
    const counterparty = m
      ? { ...svc.cp.readDeal({ theirGive: theyGive.map(slim), theirGet: theyGet.map(slim), managerProfile: m }), counterparty_data: true }
      : { receptiveness: 1, perception_delta: null, counterparty_data: false };
    return svc.pyes.stepPYes(svc.pyes.pYesFor({ counterparty, edge: { passes: true }, profile: m?.negotiation ?? null,
      team, table: pyTable, on: py.on }));
  };

  // The Trade Lab finder's best single offer (the ACQ-FLIP study's baseline, same world and seed):
  // served title-odds deals x the finder's own acceptance midpoint. A failure is reported, not hidden.
  const finderBest = () => {
    try {
      const served = svc.titleOdds.titleOddsTrades(leagueId, { teamId: me });
      if (served.error) return { error: String(served.error) };
      const found = svc.engine.findTrades(lg, { myTeamId: me, requireMutual: true, limit: 8 * 3 });
      // The plans file carries the number only; SOURCE-TABLES reads the move from pickFinderBest itself.
      const { move, ...best } = pickFinderBest(served.deals, found.deals);
      return best;
    } catch (e) {
      return { error: String(e.message ?? e) };
    }
  };

  // The study's sanity probe: the composed rescore equals the served tradeImpact on one one-for-one deal.
  const sanity = () => {
    const other = w0.prep.teams.find(t => t.roster_id !== me);
    const give = rosters.get(me).find(id => assets.get(id)?.value > 0);
    const get = rosters.get(other.roster_id).find(id => assets.get(id)?.value > 0);
    if (give == null || get == null) return null;
    const direct = tradeImpact(lg, { myTeamId: me, theirTeamId: other.roster_id, iGive: [give], iGet: [get], world: w0 });
    const state = new Map([[me, [...rosters.get(me).filter(x => x !== give), get]], [other.roster_id, [...rosters.get(other.roster_id).filter(x => x !== get), give]]]);
    const composed = wrap(w0).rescore(state, me, other.roster_id);
    return direct.me.title_after === composed.me.title_after && direct.them.title_after === composed.them.title_after;
  };
  const priceOf = (team, id) => {
    const m = layer.get(String(team));
    const mult = m ? svc.cp.playerValuation(m, slim(id)).multiplier : 1;
    return { mult, price: (players.get(id)?.value ?? 0) * mult };
  };

  // HIS-SIDE-WIRE (TM-10): ESPN's trade block from this league's payload, as planner ids (the sim's
  // asset universe carries each player's ESPN id; an unmapped one is counted, never guessed).
  const byEspn = new Map();
  // espn_id 0 is a placeholder on historical rows (ONE-PLAN 4b row 5), never a real id.
  for (const a of assets.values()) if (Number(a?.espn_id) > 0) byEspn.set(Number(a.espn_id), a.id);
  const tradeBlock = tradeBlockRead(tradeBlocks(payload), e => byEspn.get(Number(e)) ?? null);
  // CHAT-TRADE-INTEREST (shadow): what each manager's own draft / analyzer screens say he'd give and wants.
  const chatInterest = chatInterestRead(readChatTradeInterest(svc.db, Number(leagueId), Number(season)), e => byEspn.get(Number(e)) ?? null);

  // PLAYER-SCORE (flag GRIDIRON_PLAYER_SCORE / preview): the blue-chip board, and Nick's blue chips
  // join his untouchables so no step ever gives one away without his approval.
  const board = blueChipBoard(svc, lg, { rosters, players, assets, me, untouchable: untouchableIds([myNick]) });
  const untouchable = adapterUntouchable({ managerNicks: [...managers.values()].map(m => m.nick), myNick, board });

  const slots = w0.prep.slots;
  const starters = startersOf(rosters.get(me).map(id => players.get(id)).filter(Boolean), slots);
  const dl = deadlineWeek(svc, lg, payload);
  return {
    league: { id: leagueId, me, fetched_at: lg.fetched_at ?? '', week, deadline_week: dl,
      deadline_source: dl == null ? 'unknown (no deadlineDate in league settings)' : 'league settings',
      days_left_in_week: daysLeftInWeek(svc, lg, week, now), team_count: rosters.size, season,
      // TM-34: the exact deadline and review window for deadline mode (planner reads them only with its flag on).
      deadline_at: deadlineMs(payload) == null ? null : new Date(deadlineMs(payload)).toISOString(), review_hours: reviewHours(payload) },
    seed: w0.key.seed,
    world: seed => wrap(worldFor(seed)),
    rosters, players, managers, starters, freeAgents, priceStep, priceOf, sanity, tradeBlock, chatInterest,
    // FC-VALUE: which value Nick's rules read, and how many rostered players it could not price.
    valueSource: { status: fc.status, source: fc.source, fetched_at: fc.fetched_at, ...(fc.reason ? { reason: fc.reason } : {}),
      unpriced: [...players.keys()].filter(id => players.get(id).value == null).map(String) },
    // LIVE-BLEND: which P(yes) was served and, for the blend, each model's weight and record (plans.json p_yes_basis).
    pYesBasis: svc.pyes.pYesBasis(pyTable),
    // SEARCH-WIDE: the one read of its flag (the planner follows this), and the free agents this world
    // simulates; the planner builds claims only from these.
    searchWide,
    ...(claimIds.length ? { claimUniverse: new Set(claimIds.map(String)) } : {}),
    tradeLedger: tradeLedger(svc, { leagueId, season, formatKey: svc.format?.deriveFormat(lg).formatKey ?? null, assets, now }),
    // RADAR-WIRE: fcTrendOf / fcHistoryDays / newsOf / newsAlive for the flip rows' why-now label.
    ...radarReads(svc, { formatKey: svc.format?.deriveFormat(lg).formatKey ?? null }),
    // integration-7: how many executed trades the raw table holds this season, so the planner can fail
    // closed when that ledger comes back missing or empty (never plan without Nick's trade memory).
    executedTradeRows: executedTradeRows(svc, { leagueId, season }),
    // SEARCH-WIDE: the waiver-claim record a claim's P(yes) is priced on (search-wide.js#claimProbability).
    ...(claimIds.length ? { waiverRecord: waiverRecord(svc, { leagueId, season }) } : {}),
    cacheStats: () => (fast && rescoreCache ? { ...rescoreCache.stats } : null),
    // O1 radar: events + net validated opportunity change for this NFL week. Present only while
    // GRIDIRON_OPP_RADAR=1; otherwise opportunityRadar 'off', which why-now.js prints as "O1 radar off".
    ...(svc.radar?.radarFlag().on
      ? { opportunityOf: id => svc.radar.opportunityOf(id, { season: Number(season), week: Number(week) }) }
      : { opportunityRadar: 'off' }),
    // Nick's word (the one reader's nick block): never a target, a get or a flip leg (RULINGS 17).
    // Nick's word: other managers' notes, his OWN 'untouchable:' notes (#373, always) and, with the
    // board on, his blue chips (80+). vals.tradable excludes this set: never a give, walk-away or flip leg.
    untouchable,
    // PLAYER-SCORE: the served board (typed; 'off' when the flag is off) and per-player reads for ROADMAP-TIERS.
    blueChips: () => board.served,
    // CAP-1C (integration-7): the board as id -> score, the depth test for the +12% depth-only 2-for-1 premium
    // (search.js#boardOf). Absent when the board is off or empty, so the premium stays off (fails closed).
    ...(board.byId?.size ? { board: new Map([...board.byId].map(([k, r]) => [String(k), r.score])) } : {}),
    scoreOf: id => board.byId?.get(String(id)) ?? null,
    boardOf: id => { const r = board.byId?.get(String(id)); return r ? { score: r.score, label: r.label, hurt: r.hurt, gaps: r.gaps, protected: r.protected } : null; },
    ...(finder ? { finderBest } : {}),
    // DRAFT-ID-MAP (shadow, GRIDIRON_DRAFT_ID_MAP=1): draft capital by players.espn_id, owner from these rosters.
    // Guarded: a SQL error is recorded as status 'error' in _run.inputs, never a dead league entry.
    ...(draftIdMap ? { draft: draftCapitalGuarded(svc.db, { leagueId, season, rosters }) } : {}),
    // LOVE-RULE (shadow, GRIDIRON_LOVE_TAG=1): the tag's inputs for ids the producer asks about, weeks < this week.
    ...(love ? { love: (ids, { draft = null } = {}) => readLoveInputs(svc.db, { season, week, ids, draft }) } : {}),
    // SELL-HIGH (shadow, GRIDIRON_SELL_HIGH=1): TD rate vs expected TD rate on Nick's roster, weeks < this week.
    ...(sellHigh ? { sellHigh: () => readSellHighInputs(svc.db, { season, week, ids: rosters.get(me) ?? [] }) } : {}),
    // BUY-LOW (shadow, GRIDIRON_BUY_LOW=1 only): usage-up / points-down reads for ids, weeks < this week.
    ...(buyLow ? { buyLow: ids => readBuyLow(svc.db, { season, week, ids }) } : {}),
    now: () => Date.now(),
    names: () => Object.fromEntries([...players.values()].map(p => [String(p.id), `${p.name} (${p.position})`])),
    teams: () => teamNames(payload, new Map([...(svc.identity?.identityMap(leagueId) ?? [])].map(([r, i]) => [String(r), i.chat_name]))),
    rosterKey: () => [...rosters.entries()].map(([t, ids]) => `${t}:${[...ids].sort((a, b) => a - b).join(',')}`).join('|'),
  };
}

const SCORE_SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

/** This league's own draft for its season: Map espn id -> overall pick, and the pick count. */
/**
 * adapter.untouchable: the players no plan may give. Other managers' notes and Nick's own
 * 'untouchable:' notes (#373) always count, whatever the flag; PLAYER-SCORE adds his blue chips
 * (board.protect, empty when the flag is off) on top.
 */
export function adapterUntouchable({ managerNicks = [], myNick = null, board = null } = {}) {
  return new Set([...untouchableIds([...managerNicks, myNick]), ...(board?.protect ?? [])].map(String));
}

export function draftPicks(svc, lg) {
  const has = svc.db.row(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'league_draft_picks'`);
  if (!has) return { picks: new Map(), n: 0, reason: 'no league_draft_picks table' };
  const list = svc.db.rows(`SELECT player_id, overall_pick FROM league_draft_picks WHERE league_id = ? AND season = ? AND overall_pick IS NOT NULL`,
    Number(lg.id), Number(lg.season));
  const picks = new Map();
  for (const r of list) if (Number.isInteger(r.overall_pick) && r.player_id != null) picks.set(String(r.player_id), r.overall_pick);
  const n = list.reduce((m, r) => Math.max(m, Number(r.overall_pick) || 0), 0);
  return { picks, n, reason: n ? null : `no ${lg.season} draft picks on file for this league` };
}

/**
 * PLAYER-SCORE board for one league: every rostered player plus the top free agents, scored
 * (people/player-score.js), with the engine's market value (the value the planner prices
 * with) and FantasyPros' rest-of-season rank (people/fantasypros-ros.js, cached). Off: the
 * served section says so and nothing is protected.
 */
export function blueChipBoard(svc, lg, { rosters, players, assets, me, untouchable = new Set(), env = process.env }) {
  const flag = playerScoreFlag(env);
  if (flag === 'off') return { served: { status: 'off', flag }, protect: new Set(), byId: new Map() };
  const owner = new Map();
  for (const [t, ids] of rosters) for (const id of ids) owner.set(String(id), t);
  const rostered = [...players.values()].filter(p => SCORE_SKILL.has(p.position)).map(p => ({ ...p, owner: owner.get(String(p.id)) ?? null }));
  const fa = [...assets.values()].filter(p => !owner.has(String(p.id)) && SCORE_SKILL.has(p.position) && p.available !== false
    && Number.isFinite(p.ros_ppg) && p.ros_ppg > 0).sort((a, b) => b.ros_ppg - a.ros_ppg).slice(0, 40)
    .map(p => ({ id: p.id, name: p.name, position: p.position, value: Math.max(0, Number(p.value) || 0), ros_ppg: p.ros_ppg,
      injury: p.injury, available: p.available, espn_id: p.espn_id ?? null, team_abbr: p.team_abbr ?? null, ros_basis: p.ros_basis ?? null, owner: null }));
  const universe = [...rostered, ...fa];
  const { picks, n, reason: pickReason } = draftPicks(svc, lg);
  let fp;
  try { fp = fpRosFor(svc.db, universe); } catch (e) { fp = { status: 'failed', reason: `FantasyPros read failed (${e.message})`, byId: new Map() }; }
  if (fp.status !== 'ok' && svc.fpSync?.status === 'failed') fp = { ...fp, reason: `${fp.reason} ${svc.fpSync.reason}` };
  const allValues = [...assets.values()].filter(p => SCORE_SKILL.has(p.position)).map(p => ({ id: p.id, position: p.position, value: Number(p.value) || 0 }));
  const b = buildBoard(universe, { picks, nPicks: n, allValues, fp, me, untouchable });
  return {
    protect: b.protect,
    byId: new Map(b.rows.map(r => [r.player, r])),
    served: { status: 'ok', flag, weights: SCORE_WEIGHTS, labels: LABEL_NAMES, rows: b.rows, coverage: b.coverage,
      draft: { season: lg.season, picks: n, ...(pickReason ? { reason: pickReason } : {}) },
      fp: { status: fp.status, ...(fp.reason ? { reason: fp.reason } : {}), scrape_date: fp.scrape_date ?? null, prev_date: fp.prev_date ?? null,
        sync: svc.fpSync?.status ?? 'not_run' } },
  };
}
