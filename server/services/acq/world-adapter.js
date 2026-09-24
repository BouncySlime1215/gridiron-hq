/**
 * ACQ-01: the planner's adapter on a real league.
 *
 * One world per league state (season-sim.js#tradeImpactWorld, RL-19-2 fast
 * rescore, the league's one seed), built with the best free agents in its
 * universe so a claim inside a path is scored in the same world and dice as the
 * trades around it. Any roster state is rescored exactly: only the changed
 * lineups are re-solved, then the season is replayed (the ACQ-FLIP prototype's
 * composed rescore, which equals tradeImpact on the same deal; `sanity` checks
 * that on a probe deal every run).
 *
 * P(yes) is today's acceptance model: trade-acceptance.js#acceptanceBand on
 * counterparty-pricing.js#readDeal for his side of the deal, with the edge test
 * taken as passed (an intermediate chip step is not meant to be positive on its
 * own; the served finder would print no band for it). It is not fitted beyond
 * what those modules state. A claim's P(yes) is 'assumed' (no waiver-competition
 * model exists); the contract writes it 'unknown' with that reason.
 */
import { rows, row } from '../../db/index.js';
import { tradeImpactWorld, tradeImpact, __test as simTest } from '../season-sim.js';
import { counterpartyLayer, readDeal } from '../counterparty-pricing.js';
import { acceptanceBand } from '../trade-acceptance.js';
import { tradeWeekContext, assetUniverse, espnPlayerResolver } from '../trade-engine.js';
import { deriveFormat } from '../format.js';
import { leagueWire } from '../league-wire.js';

const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);
export const CLAIM_REASON = 'no waiver-competition model exists; the path math assumes the claim lands (P = 1)';

const isoOrNull = v => { const t = v == null ? NaN : Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString(); };

/** The best `n` free agents by market value, as asset ids. Empty when the wire cannot be read. */
export function topFreeAgents(lg, n) {
  if (!n) return [];
  const assets = assetUniverse(lg, deriveFormat(lg).formatKey);
  return leagueWire(lg, assets, espnPlayerResolver(assets))
    .filter(a => SCORED.has(a.position) && Number(a.value) > 0)
    .sort((a, b) => b.value - a.value).slice(0, n).map(a => a.id);
}

/**
 * @returns {{ adapter, meta } | { error }}
 */
export function leagueAdapter(leagueId, { freeAgents = 6, now = () => Date.now() } = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg) return { error: `league ${leagueId} not found` };
  if (lg.my_team_id == null) return { error: `league ${leagueId} has no team of yours set` };
  const me = String(lg.my_team_id);
  const fas = topFreeAgents(lg, freeAgents);
  const w = tradeImpactWorld(lg, { universe: fas });
  if (w.fail) return { error: `the world could not be built: ${w.fail.error ?? 'unknown failure'}` };
  const assets = w.prep.assets;
  const { lineupPoints } = simTest;
  const teamPoints = players => {
    const out = new Map();
    for (const [wk, { byRun, expected }] of w.draws) {
      const arr = new Float64Array(w.runs);
      for (let r = 0; r < w.runs; r++) arr[r] = lineupPoints(players, w.prep.slots, byRun[r], expected);
      out.set(wk, arr);
    }
    return out;
  };
  const other = w.prep.teams.find(t => t.roster_id !== me)?.roster_id;
  const rescoreFull = state => {
    const teams = w.prep.teams.map(t => (state.has(t.roster_id)
      ? { ...t, players: state.get(t.roster_id).map(id => assets.get(id)).filter(Boolean) } : t));
    const points = new Map(w.points);
    for (const t of teams) if (state.has(t.roster_id)) points.set(t.roster_id, teamPoints(t.players));
    const b = [...state.keys()].find(id => id !== me) ?? other;
    const r = tradeImpact(lg, { myTeamId: me, theirTeamId: b, iGive: [], iGet: [], world: { ...w, prep: { ...w.prep, teams }, points } });
    if (r.error) throw new Error(`rescore failed: ${r.error}`);
    return r;
  };
  const rescore = state => {
    const m = rescoreFull(state).me;
    return { title_before: m.title_before, title_after: m.title_after, title_delta: m.title_delta,
      title_delta_se: m.title_delta_se, clears: m.title_delta_clears_noise };
  };

  const week = tradeWeekContext();
  const cp = counterpartyLayer(leagueId, { season: week.season, week: week.week });
  const blocked = new Set(rows(`SELECT roster_id FROM manager_profiles WHERE league_id = ? AND tradeability = 'never'`, leagueId)
    .map(r => String(r.roster_id)));
  const value = id => Math.max(0, Number(assets.get(id)?.value) || 0);
  const slim = id => { const p = assets.get(id); return { id, name: p?.name, position: p?.position, value: p?.value }; };
  const pAccept = (team, theyGive, theyGet) => {
    const m = cp.get(String(team)) ?? null;
    const counterparty = m
      ? { ...readDeal({ theirGive: theyGive.map(slim), theirGet: theyGet.map(slim), managerProfile: m }), counterparty_data: true }
      : { receptiveness: 1, perception_delta: null, counterparty_data: false };
    const band = acceptanceBand({ counterparty, edge: { passes: true }, profile: m?.negotiation ?? null });
    return { p: band.band?.mid ?? 0, low: band.band?.low ?? null, high: band.band?.high ?? null, basis: band.basis ?? null };
  };

  // Probe: the composed rescore equals tradeImpact on the same one-for-one deal.
  let sanity = null;
  const mine = w.prep.teams.find(t => t.roster_id === me);
  const give = mine?.players.find(p => value(p.id) > 0)?.id;
  const oth = w.prep.teams.find(t => t.roster_id === other);
  const get = oth?.players.find(p => value(p.id) > 0)?.id;
  if (give != null && get != null) {
    const direct = tradeImpact(lg, { myTeamId: me, theirTeamId: other, iGive: [give], iGet: [get], world: w });
    const st = new Map([[me, [...mine.players.map(p => p.id).filter(x => x !== give), get]],
      [other, [...oth.players.map(p => p.id).filter(x => x !== get), give]]]);
    const composed = rescoreFull(st);
    sanity = direct.me?.title_after === composed.me.title_after && direct.them?.title_after === composed.them.title_after;
  }

  const adapter = {
    me,
    teams: w.prep.teams.map(t => t.roster_id),
    blocked,
    freeAgents: fas.filter(id => assets.has(id)),
    roster: t => w.prep.teams.find(x => x.roster_id === t).players.map(p => p.id),
    value,
    tradable: id => SCORED.has(assets.get(id)?.position) && value(id) > 0,
    rescore,
    pAccept,
    claimP: () => ({ p: 1, basis: 'assumed', reason: CLAIM_REASON }),
    now
  };
  const name = id => { const p = assets.get(Number(id)) ?? assets.get(id); return p ? `${p.name} (${p.position})` : `#${id}`; };
  return { adapter, meta: { league: Number(leagueId), me, name, lg, sanity, runs: w.runs, seed: w.key.seed,
    as_of: isoOrNull(lg.fetched_at) } };
}
