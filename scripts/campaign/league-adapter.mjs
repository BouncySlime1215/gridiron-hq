/**
 * The real adapter for server/services/campaign/planner.js: one league's state
 * read from the DB and the season simulator. Runs in the producer process only
 * (scripts/campaign/produce-plans.mjs), never on a request.
 *
 *   world(seed)       season-sim.js#tradeImpactWorld (the fast rescore, RL-19-2)
 *                     under that seed; the planning seed is tradeImpactSeed(lg),
 *                     the same dice every other title-odds surface uses
 *   priceStep         today's model: counterparty-pricing.js#readDeal ->
 *                     trade-acceptance.js#acceptanceBand midpoint (edge assumed
 *                     passed for every step, as in the ACQ-FLIP prototype)
 *   managers          counterparty layer (activity, needs) + timing read + chat labels
 *   finderBest        the Trade Lab finder's best single offer (title-odds-trades.js x
 *                     findTrades acceptance midpoint), the study's baseline; off with --no-finder
 *   sanity            composed rescore == served tradeImpact on one one-for-one deal
 */
import { chatLabels } from '../../server/services/campaign/partners.js';
import { resolveUntouchables, untouchableIds } from '../../server/services/people/profile-reader.js';
import { PREVIEW_ENV } from '../../server/services/preview-mode.js';

const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);
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

export async function loadServices() {
  const db = await import('../../server/db/index.js');
  return {
    db,
    sim: await import('../../server/services/season-sim.js'),
    cp: await import('../../server/services/counterparty-pricing.js'),
    acc: await import('../../server/services/trade-acceptance.js'),
    engine: await import('../../server/services/trade-engine.js'),
    tactics: await import('../../server/services/trade-tactics.js'),
    week: await import('../../server/services/league-week.js'),
    horizon: await import('../../server/services/trade-horizon.js'),
    titleOdds: await import('../../server/services/title-odds-trades.js'),
    identity: await import('../../server/services/manager-identity.js'),
  };
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

/** The trade deadline as a week, from ESPN's deadlineDate and the NFL schedule; null when unknown. */
function deadlineWeek(svc, lg, payload) {
  const ms = Number(payload?.settings?.tradeSettings?.deadlineDate);
  if (!(ms > 0)) return null;
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

/**
 * Build the adapter for one league. chat: Map roster -> { profile, negotiation, sentiment: [{ player
 * (name), sentiment_mean, n }], nick } from scripts/campaign/chat-labels.mjs, or null (no chat -> every
 * label 'unknown').
 */
export function buildAdapter(svc, leagueId, { chat = null, now = Date.now(), finder = true } = {}) {
  const lg = svc.db.row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg) throw new Error(`league ${leagueId} not found`);
  const payload = JSON.parse(lg.payload ?? '{}');
  const me = String(lg.my_team_id);
  const { tradeImpactWorld, tradeImpact, __test: { lineupPoints } } = svc.sim;
  const w0 = tradeImpactWorld(lg);
  if (w0.fail) return { fail: String(w0.fail?.error ?? w0.fail) };
  const assets = w0.prep.assets;
  const worlds = new Map([[w0.key.seed, w0]]);
  const worldFor = seed => {
    if (!worlds.has(seed)) worlds.set(seed, tradeImpactWorld(lg, { seed, projections: w0.projections }));
    return worlds.get(seed);
  };

  const teamPoints = (w, players) => {
    const out = new Map();
    for (const [wk, { byRun, expected }] of w.draws) {
      const arr = new Float64Array(w.runs);
      for (let run = 0; run < w.runs; run++) arr[run] = lineupPoints(players, w.prep.slots, byRun[run], expected);
      out.set(wk, arr);
    }
    return out;
  };
  const seasonAvg = (pts, runs) => {
    const avg = new Float64Array(runs);
    for (const arr of pts.values()) for (let r = 0; r < runs; r++) avg[r] += arr[r] / pts.size;
    return avg;
  };
  const wrap = w => {
    if (w.fail) return { fail: String(w.fail?.error ?? w.fail) };
    const baseAvg = seasonAvg(w.points.get(me), w.runs);
    const baseMean = baseAvg.reduce((s, x) => s + x, 0) / w.runs;
    return {
      seed: w.key.seed,
      rescore(state, a = me, b = null) {
        const teams = w.prep.teams.map(t => (state.has(t.roster_id)
          ? { ...t, players: state.get(t.roster_id).map(id => assets.get(id)).filter(Boolean) } : t));
        const points = new Map(w.points);
        for (const t of teams) if (state.has(t.roster_id)) points.set(t.roster_id, teamPoints(w, t.players));
        const other = b ?? [...state.keys()].find(id => id !== a) ?? teams.find(t => t.roster_id !== a).roster_id;
        const r = tradeImpact(lg, { myTeamId: a, theirTeamId: other, iGive: [], iGet: [], seed: w.key.seed, world: { ...w, prep: { ...w.prep, teams }, points } });
        if (r.error) throw new Error(r.error);
        if (a === me) {
          const after = state.has(me) ? seasonAvg(points.get(me), w.runs) : baseAvg;
          let s = 0, s2 = 0;
          for (let i = 0; i < w.runs; i++) { const d = after[i] - baseAvg[i]; s += d; s2 += d * d; }
          const m = s / w.runs, se = Math.sqrt(Math.max(0, s2 / w.runs - m * m) / Math.max(1, w.runs - 1));
          Object.assign(r.me, { points_before: baseMean, points_delta: m, points_delta_se: se, points_delta_clears: se > 0 && Math.abs(m) > 2 * se });
        }
        return r;
      },
      weekly(ids) {
        const pts = teamPoints(w, ids.map(id => assets.get(id)).filter(Boolean));
        return [...pts.entries()].sort((x, y) => x[0] - y[0]).map(([week, arr]) => ({ week, samples: Array.from(arr) }));
      },
    };
  };

  const rosters = new Map(w0.prep.teams.map(t => [t.roster_id, t.players.map(p => p.id)]));
  const players = new Map();
  const slim = id => { const p = assets.get(id); return { id, name: p?.name, position: p?.position, value: p?.value }; };
  const addPlayer = id => {
    const p = assets.get(id);
    if (!p) return;
    players.set(id, { id, name: p.name, position: p.position, value: Math.max(0, Number(p.value) || 0),
      ros_ppg: p.ros_ppg, injury: p.injury, bye: p.bye, trend_kind: p.trend_kind, available: p.available });
  };
  for (const ids of rosters.values()) ids.forEach(addPlayer);
  const rostered = new Set([...rosters.values()].flat());
  const freeAgents = [...assets.values()].filter(p => !rostered.has(p.id) && SCORED.has(p.position) && p.available !== false
    && Number.isFinite(p.ros_ppg) && p.ros_ppg > 0).sort((a, b) => b.ros_ppg - a.ros_ppg).slice(0, 40)
    .map(p => ({ id: p.id, name: p.name, position: p.position, ros_ppg: p.ros_ppg }));

  const nameToId = name => [...players.values()].find(p => p.name === name)?.id ?? null;
  const week = svc.week.leagueCurrentWeek(lg);
  const season = lg.season ?? payload.seasonId;
  const layer = svc.cp.counterpartyLayer(leagueId, { season, week });
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
    const send = svc.tactics.sendWindow(tm, { now });
    managers.set(t, {
      receptiveness: m?.receptiveness ?? null, tier: m?.tier ?? null, needs: m?.needs ?? null,
      blocked: blocked.has(t),
      checked_out: activity.get(String(t))?.checked_out ?? false,
      checked_out_source: activity.get(String(t))?.source ?? null,
      p_checked_out: activity.get(String(t))?.p ?? null,
      title_now: titleByTeam.get(t) ?? null,
      sent_this_week: sent.get(t) ?? 0,
      send_when: send,
      // Nick's block (the one reader); 'untouchable: <player>' notes resolved against this roster's players.
      nick: resolveUntouchables(chat?.get(t)?.nick ?? null, (rosters.get(t) ?? []).map(id => players.get(id)).filter(Boolean)),
      chat: chat?.has(t) ? chatLabels({ ...chat.get(t),
        sentiment: (chat.get(t).sentiment ?? []).map(x => ({ ...x, player: nameToId(x.player) ?? x.player })) }) : chatLabels(),
    });
  }

  const priceStep = (team, theyGive, theyGet) => {
    const m = layer.get(String(team)) ?? null;
    const counterparty = m
      ? { ...svc.cp.readDeal({ theirGive: theyGive.map(slim), theirGet: theyGet.map(slim), managerProfile: m }), counterparty_data: true }
      : { receptiveness: 1, perception_delta: null, counterparty_data: false };
    const band = svc.acc.acceptanceBand({ counterparty, edge: { passes: true }, profile: m?.negotiation ?? null });
    const b = band.band;
    return { p: b?.mid ?? 0, band: b ? { low: b.low, high: b.high } : null, basis: band.basis };
  };

  // The Trade Lab finder's best single offer (the ACQ-FLIP study's baseline, same world and seed):
  // served title-odds deals x the finder's own acceptance midpoint. A failure is reported, not hidden.
  const finderBest = () => {
    try {
      const served = svc.titleOdds.titleOddsTrades(leagueId, { teamId: me });
      if (served.error) return { error: String(served.error) };
      const found = svc.engine.findTrades(lg, { myTeamId: me, requireMutual: true, limit: 8 * 3 });
      const same = (a, b) => a.map(p => p.id).join() === b.map(p => p.id).join();
      let best = null, n = 0;
      for (const d of served.deals ?? []) {
        const f = (found.deals ?? []).find(x => x.partner_id === d.partner_id && same(x.i_give, d.i_give) && same(x.i_get, d.i_get));
        const p = f?.acceptance?.band?.mid;
        if (!Number.isFinite(p) || !Number.isFinite(d.title_delta)) continue;
        n++;
        const e = { expected: p * d.title_delta, se: Number.isFinite(d.title_delta_se) ? p * d.title_delta_se : null };
        if (!best || e.expected > best.expected) best = e;
      }
      return best ? { ...best, n } : { error: `no served deal carried a finder acceptance price (${(served.deals ?? []).length} served)` };
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

  // IS-TITLE (shadow): Nick's title odds importance-sampled on w0's seed, run count, pools
  // and copula (season-sim.js#titleWorldIS). A second world build; only the producer's
  // `_run.inputs.is_title` reads it, behind GRIDIRON_IS_TITLE.
  const isTitle = () => {
    const w = svc.sim.titleWorldIS(lg, { teamId: me, seed: w0.key.seed, runs: w0.runs,
      projections: w0.projections, universe: w0.universe });
    if (w.fail) return { status: 'error', error: String(w.fail?.error ?? w.fail) };
    return svc.sim.titleOddsIS(w, me);
  };

  const slots = w0.prep.slots;
  const starters = startersOf(rosters.get(me).map(id => players.get(id)).filter(Boolean), slots);
  const dl = deadlineWeek(svc, lg, payload);
  return {
    league: { id: leagueId, me, fetched_at: lg.fetched_at ?? '', week, deadline_week: dl,
      deadline_source: dl == null ? 'unknown (no deadlineDate in league settings)' : 'league settings',
      days_left_in_week: daysLeftInWeek(svc, lg, week, now), team_count: rosters.size, season },
    seed: w0.key.seed,
    world: seed => wrap(worldFor(seed)),
    rosters, players, managers, starters, freeAgents, priceStep, priceOf, sanity, isTitle,
    // Nick's word (the one reader's nick block): never a target, a get or a flip leg (RULINGS 17).
    // His notes on his OWN roster ("untouchable: Nico Collins") protect his players the same way:
    // they are never given (vals.tradable excludes this set). Nick 9/24: blue chips are not for sale.
    untouchable: untouchableIds([...managers.values()].map(m => m.nick).concat([myNick])),
    ...(finder ? { finderBest } : {}),
    now: () => Date.now(),
    names: () => Object.fromEntries([...players.values()].map(p => [String(p.id), `${p.name} (${p.position})`])),
    teams: () => teamNames(payload, new Map([...(svc.identity?.identityMap(leagueId) ?? [])].map(([r, i]) => [String(r), i.chat_name]))),
    rosterKey: () => [...rosters.entries()].map(([t, ids]) => `${t}:${[...ids].sort((a, b) => a - b).join(',')}`).join('|'),
  };
}
