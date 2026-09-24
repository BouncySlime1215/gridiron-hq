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
 */
import { chatLabels } from '../../server/services/campaign/partners.js';
import { m7Timing, managerUrgency, sendWhen } from '../../server/services/campaign/urgency.js';

const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);
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

/** Offers Nick sent each manager in the last 7 days (ESPN proposals + War Room "I sent it" log). */
function sentThisWeek(svc, leagueId, season, me, now, offerLog = []) {
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
  for (const o of offerLog) {
    if (String(o.league) !== String(leagueId) || !Number.isFinite(Date.parse(o.at)) || now - Date.parse(o.at) > 7 * DAY) continue;
    out.set(String(o.manager), (out.get(String(o.manager)) ?? 0) + 1);
  }
  return out;
}

/**
 * Build the adapter for one league. chat: Map roster -> { profile, negotiation, sentiment: [{ player
 * (name), sentiment_mean, n }] } from scripts/campaign/chat-labels.mjs, or null (no chat -> every
 * label 'unknown'); offerLog: parsed War Room offer log rows.
 */
export function buildAdapter(svc, leagueId, { chat = null, offerLog = [], now = Date.now() } = {}) {
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
  const sent = sentThisWeek(svc, leagueId, season, me, now, offerLog);
  const titleByTeam = new Map((w0.base?.teams ?? []).map(t => [String(t.roster_id), t.title_odds]));
  const managers = new Map();
  const m7 = m7Timing();
  const leftInWeek = daysLeftInWeek(svc, lg, week, now);
  for (const t of rosters.keys()) {
    if (t === me) continue;
    const m = layer.get(t) ?? null;
    const tm = timing.get(t) ?? null;
    let send = svc.tactics.sendWindow(tm, { now });
    let urgency = null;
    if (m7.on) {
      // M7-TIMING: urgency spike from his starters, his streak, his chat and his byes.
      const roster = rosters.get(t);
      urgency = managerUrgency({ roster, starters: startersOf(roster.map(id => players.get(id)).filter(Boolean), w0.prep.slots),
        players, schedule: payload.schedule ?? null, team: t, week, needMove: chat?.get(t)?.need_move ?? null });
      send = sendWhen(send, urgency, { now, daysLeftInWeek: leftInWeek, preview: m7.preview });
    }
    managers.set(t, {
      receptiveness: m?.receptiveness ?? null, tier: m?.tier ?? null, needs: m?.needs ?? null,
      blocked: blocked.has(t),
      checked_out: tm?.read_state === 'present' && tm.actions_n === 0,
      title_now: titleByTeam.get(t) ?? null,
      sent_this_week: sent.get(t) ?? 0,
      send_when: send,
      urgency,
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
    return { p: band.band?.mid ?? 0, basis: band.basis };
  };
  const priceOf = (team, id) => {
    const m = layer.get(String(team));
    const mult = m ? svc.cp.playerValuation(m, slim(id)).multiplier : 1;
    return { mult, price: (players.get(id)?.value ?? 0) * mult };
  };

  const slots = w0.prep.slots;
  const starters = startersOf(rosters.get(me).map(id => players.get(id)).filter(Boolean), slots);
  const dl = deadlineWeek(svc, lg, payload);
  return {
    league: { id: leagueId, me, fetched_at: lg.fetched_at ?? '', week, deadline_week: dl,
      deadline_source: dl == null ? 'unknown (no deadlineDate in league settings)' : 'league settings',
      days_left_in_week: leftInWeek, team_count: rosters.size, season },
    seed: w0.key.seed,
    world: seed => wrap(worldFor(seed)),
    rosters, players, managers, starters, freeAgents, priceStep, priceOf,
    now: () => Date.now(),
    names: () => Object.fromEntries([...players.values()].map(p => [String(p.id), `${p.name} (${p.position})`])),
    rosterKey: () => [...rosters.entries()].map(([t, ids]) => `${t}:${[...ids].sort((a, b) => a - b).join(',')}`).join('|'),
  };
}
