/**
 * FLIP-01: build computeFlipMap's world from one real league.
 *
 * Ported from the ACQ-FLIP prototype's harness (scripts/study/acq-flip-proto.mjs,
 * PR #227): one fast-rescore world per league (season-sim.js#tradeImpactWorld,
 * RL-19-2), every roster state rescored exactly by re-solving only the changed
 * lineups, today's counterparty model for prices and P(accept).
 *
 * Clone price = market value x counterparty-pricing.js#playerValuation's
 * multiplier for that manager. CLONE-01b adds its fitted `clone` source inside
 * playerValuation, so this reads the clone the day it lands without a change
 * here. P(accept) = trade-acceptance.js#acceptanceBand's midpoint on readDeal,
 * with the edge test passed (a leg is not meant to be positive on its own).
 */
import { row, rows } from '../../db/index.js';
import { tradeImpactWorld, tradeImpact, __test as simTest } from '../season-sim.js';
import { counterpartyLayer, readDeal, playerValuation } from '../counterparty-pricing.js';
import { acceptanceBand } from '../trade-acceptance.js';
import { tradeWeekContext } from '../trade-engine.js';

const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * @returns {{ ctx, names, me, rescores: () => number } | { error: string }}
 */
export function flipWorld(leagueId) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg) return { error: `league ${leagueId} not found` };
  if (lg.my_team_id == null) return { error: `league ${leagueId} has no my_team_id` };
  const me = String(lg.my_team_id);
  const w = tradeImpactWorld(lg);
  if (!w || w.fail) return { error: `title-odds world failed${w?.fail ? `: ${w.fail}` : ''}` };
  const assets = w.prep.assets;
  let rescores = 0;

  const teamPoints = players => {
    const out = new Map();
    for (const [wk, { byRun, expected }] of w.draws) {
      const arr = new Float64Array(w.runs);
      for (let run = 0; run < w.runs; run++) arr[run] = simTest.lineupPoints(players, w.prep.slots, byRun[run], expected);
      out.set(wk, arr);
    }
    return out;
  };
  const baseRoster = new Map(w.prep.teams.map(t => [String(t.roster_id), t.players.map(p => p.id)]));
  const rosterOf = (state, id) => state.get(id) ?? baseRoster.get(id);
  /** state: Map roster_id -> ids for changed teams only; tradeImpact's me (a) / them (b) vs today. */
  const rescore = (state, a, b) => {
    rescores++;
    const teams = w.prep.teams.map(t => state.has(String(t.roster_id))
      ? { ...t, players: state.get(String(t.roster_id)).map(id => assets.get(id)).filter(Boolean) } : t);
    const points = new Map(w.points);
    for (const t of teams) if (state.has(String(t.roster_id))) points.set(t.roster_id, teamPoints(t.players));
    const r = tradeImpact(lg, { myTeamId: a, theirTeamId: b, iGive: [], iGet: [],
      world: { ...w, prep: { ...w.prep, teams }, points } });
    if (r.error) throw new Error(`rescore failed: ${r.error}`);
    return r;
  };
  const applyTrade = (state, x, y, xGives, yGives) => {
    const s = new Map(state);
    const gx = new Set(xGives), gy = new Set(yGives);
    s.set(x, [...rosterOf(s, x).filter(id => !gx.has(id)), ...yGives]);
    s.set(y, [...rosterOf(s, y).filter(id => !gy.has(id)), ...xGives]);
    return s;
  };

  const week = tradeWeekContext();
  const cp = counterpartyLayer(leagueId, { season: week.season, week: week.week });
  const blocked = new Set(rows(`SELECT roster_id FROM manager_profiles WHERE league_id = ? AND tradeability = 'never'`, leagueId)
    .map(r => String(r.roster_id)));
  const val = id => Math.max(0, Number(assets.get(id)?.value) || 0);
  const slim = id => { const p = assets.get(id); return { id, name: p?.name, position: p?.position, value: p?.value }; };
  const tradable = id => SCORED.has(assets.get(id)?.position) && val(id) > 0;

  const priceOf = (team, id) => {
    const m = cp.get(String(team));
    const mult = m ? playerValuation(m, slim(id)).multiplier : 1;
    return { mult, price: val(id) * mult };
  };
  const pAccept = (team, theyGive, theyGet) => {
    const m = cp.get(String(team)) ?? null;
    const counterparty = m
      ? { ...readDeal({ theirGive: theyGive.map(slim), theirGet: theyGet.map(slim), managerProfile: m }), counterparty_data: true }
      : { receptiveness: 1, perception_delta: null, counterparty_data: false };
    const band = acceptanceBand({ counterparty, edge: { passes: true }, profile: m?.negotiation ?? null });
    return band.band?.mid ?? NaN;
  };

  // Nick's single-player values (exact rescores): what each outside player adds, what each of his costs.
  const nickAdd = new Map(), nickLoss = new Map();
  for (const [tid, ids] of baseRoster) {
    if (tid === me) continue;
    for (const pid of ids.filter(tradable)) nickAdd.set(pid, rescore(applyTrade(new Map(), me, tid, [], [pid]), me, tid).me.title_delta);
  }
  const anyOther = [...baseRoster.keys()].find(id => id !== me);
  for (const pid of baseRoster.get(me).filter(tradable)) {
    nickLoss.set(pid, rescore(new Map([[me, baseRoster.get(me).filter(id => id !== pid)]]), me, anyOther).me.title_delta);
  }

  const ctx = {
    me, teams: baseRoster, tradable, val, priceOf, pAccept, nickAdd, nickLoss, blocked,
    move(pid, a, b) {
      const r = rescore(applyTrade(new Map(), b, a, [], [pid]), b, a);
      return { dB: r.me.title_delta, seB: r.me.title_delta_se, dA: r.them.title_delta, seA: r.them.title_delta_se };
    },
    legs(a, b, pid, giveA, getB) {
      const s1 = applyTrade(new Map(), me, a, [giveA], [pid]);
      const s2 = applyTrade(s1, me, b, [pid], [getB]);
      const r1 = rescore(s1, me, a), r2 = rescore(s2, me, b);
      return { d1: r1.me.title_delta, d2: r2.me.title_delta, se2: r2.me.title_delta_se, clears2: r2.me.title_delta_clears_noise };
    }
  };
  const names = id => `${assets.get(id)?.name ?? id} (${assets.get(id)?.position ?? '?'})`;
  return { ctx, names, me, rescores: () => rescores };
}
