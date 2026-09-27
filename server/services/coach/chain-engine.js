/**
 * COACH-CHAIN runner: one chain for one league, on the campaign adapter the Coach engine worker holds
 * (coach/negotiator.js#engineChain posts it there; nothing here runs on the request thread).
 *
 * It gathers what campaign/chain.js is pure over, each from its one producer:
 *   - the adapter: scripts/campaign/league-adapter.mjs#buildAdapter (the War Room plan's world and seed);
 *   - Nick's rules: campaign/never-give.js#ruleGate (fails closed: an unreadable rule source -> no chain);
 *   - the lineup slots: trade-engine.js#lineupSlots and FLEX_ELIGIBLE (what the sim starts);
 *   - the free-agent pool (replacement level): league-adapter.mjs#freeAgentPool over the world's own
 *     asset universe (trade-engine.js#assetUniverse, the cached map the world was built from);
 *   - the objective: the planner's own (objectives file + War Room requests, campaign/requests.js#leagueInputs).
 * Nick's words name players ("Nico", "Amon-Ra", "Etienne"); resolveMoves turns them into ids against
 * the rosters (gives from his, gets from one other team's), and asks when a name is ambiguous.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chain } from '../campaign/chain.js';
import { ruleGate } from '../campaign/never-give.js';
import { teamLabel } from '../campaign/playbook.js';
import { warRoomPlansPath } from '../warroom-flag.js';

/** The worker imports this module by URL (negotiator.js); the static import there is how the wiring map sees it. */
export const CHAIN_MODULE_URL = import.meta.url;

const S = x => String(x);
const norm = t => String(t ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[’'`.]/g, '').replace(/-/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Players whose name a query fits: the full name, the first or last name, or every word of the query in
 * the name ("Amon-Ra" -> "Amon-Ra St. Brown", "Etienne" -> "Travis Etienne Jr."). An id matches itself.
 */
export function matchPlayers(query, candidates) {
  const q = norm(query);
  if (!q) return [];
  const byId = candidates.filter(c => S(c.id) === String(query).trim());
  if (byId.length) return byId;
  const full = candidates.filter(c => norm(c.name) === q);
  if (full.length) return full;
  const words = q.split(' ');
  return candidates.filter(c => {
    const toks = norm(c.name).split(' ');
    return words.every(w => toks.includes(w));
  });
}

/**
 * Nick's moves in names or ids -> ids. A give must be on his roster as the chain stands before that move;
 * the gets must all be on ONE other team's roster (move.team, when given, must be that team).
 * -> { moves } | { error, ask? } (ask: the candidates when a name fits more than one player).
 */
export function resolveMoves(adapter, moves) {
  const me = S(adapter.league.me);
  const P = adapter.players;
  const rosters = new Map([...adapter.rosters].map(([t, ids]) => [S(t), ids.map(S)]));
  const out = [];
  const named = id => ({ id: S(id), name: P.get(id)?.name ?? P.get(Number(id))?.name ?? S(id) });
  for (const [k, m] of (moves ?? []).entries()) {
    const mine = rosters.get(me) ?? [];
    const give = [], get = [];
    for (const q of m.give ?? []) {
      const hit = matchPlayers(q, mine.map(named));
      if (hit.length !== 1) return { error: hit.length ? `"${q}" fits more than one of your players` : `"${q}" is not on your roster${k ? ' at that step' : ''}`, ask: hit.map(h => h.name) };
      give.push(hit[0].id);
    }
    let team = m.team != null ? S(m.team) : null;
    for (const q of m.get ?? []) {
      const pool = [...rosters].filter(([t]) => t !== me && (team == null || t === team)).flatMap(([t, ids]) => ids.map(id => ({ ...named(id), team: t })));
      const hit = matchPlayers(q, pool);
      if (hit.length !== 1) return { error: hit.length ? `"${q}" fits more than one player` : `"${q}" is not on ${team != null ? 'that team\'s' : 'another team\'s'} roster`, ask: hit.map(h => h.name) };
      team = hit[0].team;
      get.push(hit[0].id);
    }
    if (!give.length || !get.length || team == null) return { error: 'a move needs at least one player each way' };
    out.push({ team, give, get });
    // The next move reads the rosters as they stand after this one.
    rosters.set(me, [...mine.filter(id => !give.includes(id)), ...get]);
    rosters.set(team, [...rosters.get(team).filter(id => !get.includes(id)), ...give]);
  }
  return { moves: out };
}

/**
 * The league's objective exactly as the planner reads it: the objectives-file row (GRIDIRON_WARROOM_OBJECTIVES,
 * else objectives.json next to the plans) folded with Nick's War Room requests (campaign/requests.js#leagueInputs,
 * read only; nothing is consumed). A player objective ("Get X") is scored on the league goal, as in the plan.
 */
export async function objectiveFor(leagueId, { plansPath = warRoomPlansPath(), env = process.env } = {}) {
  const file = env.GRIDIRON_WARROOM_OBJECTIVES?.trim() || path.join(path.dirname(path.resolve(plansPath)), 'objectives.json');
  const row = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))?.[S(leagueId)] ?? null : null;
  // Dynamic: requests.js opens the app DB on import.
  const { leagueInputs } = await import('../campaign/requests.js');
  return leagueInputs(Number(leagueId), { objectiveRow: row }).objective;
}

/** Every player id a chain result names -> his name (no ids reach a screen). */
function namesOf(res, adapter, freeAgents) {
  const ids = new Set();
  const addMove = m => { for (const id of [...(m?.give ?? []), ...(m?.get ?? [])]) ids.add(S(id)); if (m?.via_claim) addMove(m.via_claim); };
  const addHole = h => { if (h?.player) ids.add(h.player); if (h?.replacement) ids.add(h.replacement.player); if (h?.reach?.cheapest) ids.add(h.reach.cheapest.player); };
  addHole(res.nothing?.hole);
  for (const s of res.steps ?? []) {
    addMove(s.move); addHole(s.hole);
    if (s.reach?.cheapest) ids.add(s.reach.cheapest.player);
    for (const f of s.fills ?? []) for (const st of f.steps) addMove(st);
  }
  const L = res.lookahead;
  for (const m of [...(L?.best?.line ?? []), ...(L?.yours?.line ?? []), ...(L?.first_moves ?? []).flatMap(f => f.line)]) addMove(m);
  const fa = new Map(freeAgents.map(f => [S(f.id), f.name]));
  const out = {};
  for (const id of ids) out[id] = adapter.players.get(Number(id))?.name ?? adapter.players.get(id)?.name ?? fa.get(id) ?? null;
  return out;
}

/**
 * The chain for one league (runs in the Coach engine worker). svc: league-adapter.mjs#loadServices;
 * mod: the league-adapter module; adapter: its buildAdapter for this league.
 */
export async function runChain({ svc, mod, adapter, leagueId, moves, opts = {}, plansPath = warRoomPlansPath() }) {
  const lg = svc.db.row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg) return { error: 'the league is not in the database' };
  const gate = ruleGate({ row: svc.db.row, rows: svc.db.rows }, { leagueId, plansPath });
  if (!gate.applies) return { error: 'this is not one of your leagues' };
  if (gate.rules.closed) return { error: `your rules could not be read (${gate.rules.closed}), so no chain is priced` };
  const resolved = resolveMoves(adapter, moves);
  if (resolved.error) return { error: resolved.error, ask: resolved.ask ?? [] };
  const assets = svc.engine.assetUniverse(lg, svc.format.deriveFormat(lg).formatKey);
  const freeAgents = mod.freeAgentPool(assets, new Set([...adapter.rosters.values()].flat()));
  let objective;
  try { objective = await objectiveFor(leagueId, { plansPath }); } catch (e) { return { error: `your goal for this league could not be read (${e.message})` }; }
  const res = chain(adapter, resolved.moves, { rules: gate.rules, slots: svc.engine.lineupSlots(lg), flex: svc.engine.FLEX_ELIGIBLE,
    objective, freeAgents, prefer: ['QB', 'RB', 'WR', 'TE'].includes(opts?.prefer) ? opts.prefer : null });
  if (res.error) return res;
  const teams = adapter.teams?.() ?? {};
  const teamIds = new Set([...(res.steps ?? []).flatMap(s => [s.move?.team, ...(s.fills ?? []).map(f => f.team)]), ...(res.steps ?? []).map(s => s.reach?.cheapest?.team)].filter(t => t != null && t !== 'free_agent').map(S));
  return { ...res, goal_source: objective.source, as_of: lg.fetched_at ?? null,
    names: namesOf(res, adapter, freeAgents), teams: Object.fromEntries([...teamIds].map(t => [t, teamLabel(teams, t)])) };
}
