/**
 * Monte Carlo lookahead for the pick on the clock.
 *
 * rankTargets() answers "who is the best value right now". This answers the
 * question that actually decides a draft: "if I take X now, what roster do I
 * end up with?" — by playing the rest of the draft out a few hundred times
 * for each candidate. Opponents pick by market rank with the same noise the
 * fitted goneBy() curve implies, filtered by what their roster still needs;
 * the user's later picks follow the same value logic the board uses. The
 * score is the projected points of the finished starting lineup plus a
 * discounted bench, so a pick that looks great alone but leaves a hole the
 * board cannot fill later loses to one that doesn't.
 *
 * Pure over boardState()'s output: no DB access, no I/O, deterministic for a
 * seed (common random numbers across candidates, so their differences are
 * not swamped by simulation noise).
 */
import { slotForPick } from './espn-draft.js';
import { rosterNeeds, buildLineup, FLEX_ELIGIBLE } from './draft-assist.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BENCH_DISCOUNT = 0.25;
const BENCH_TARGET = { QB: 1, RB: 3, WR: 3, TE: 0, K: 0, DEF: 0 };

function interest(needs, pos) {
  if ((needs.starters[pos] ?? 0) > 0) return 1;
  if (FLEX_ELIGIBLE.includes(pos) && (needs.starters.FLEX ?? 0) > 0) return 0.9;
  if ((needs.depth[pos] ?? 0) > 0) return 0.6;
  if (pos === 'K' || pos === 'DEF') return 0.05;
  return ['QB', 'TE'].includes(pos) ? 0.12 : 0.35;
}

/** Roster value: starting lineup projection plus a discounted bench. */
function rosterValue(picks, slots, replacement) {
  const lineup = buildLineup(picks, slots);
  const bench = lineup.bench
    .map(p => Math.max(0, (p.projected_points ?? 0) - (replacement[p.position] ?? 0)))
    .sort((a, b) => b - a).slice(0, 4)
    .reduce((s, v) => s + v, 0);
  return (lineup.projected_total ?? 0) + BENCH_DISCOUNT * bench;
}

export function lookahead(state, { sims = 200, candidates = 6, seed = 20260906, targets = [] } = {}) {
  const { draft, on_the_clock, positions } = state;
  if (!on_the_clock.my_turn && on_the_clock.picks_until_my_turn == null) return null;
  const slots = draft.roster_slots;
  const teams = draft.team_count;
  const total = teams * draft.rounds;
  const replacement = Object.fromEntries(Object.entries(positions).map(([pos, p]) => [pos, p.replacement_points ?? 0]));

  // Pool: everything the board knows, with a usable value for players ESPN has no line for.
  const pool = state.available.map((p, i) => ({
    idx: i, player_id: p.player_id, name: p.name, position: p.position, team_abbr: p.team_abbr,
    market_rank: p.market_rank ?? (200 + i), pick_number: null,
    projected_points: p.projected_points ?? Math.max(0, (replacement[p.position] ?? 0) - 8 - i * 0.1)
  }));

  // Current rosters for every slot, as counts, from the board.
  const baseCounts = {};
  for (let s = 1; s <= teams; s++) baseCounts[s] = { ...(state.team_counts?.[s] ?? {}) };
  const myPicksNow = state.my_team.picks.map(p => ({ ...p }));

  // The user's decision point: the next pick they own (now, or after the
  // intervening picks are simulated).
  const firstPick = on_the_clock.pick_number;
  const myFirst = on_the_clock.my_turn ? firstPick : on_the_clock.my_upcoming_picks[0];
  if (!myFirst) return null;

  const cands = (targets.length ? targets : state.targets ?? []).slice(0, candidates);
  if (!cands.length) return null;
  const depthW = 0.5 * Math.min(1, teams / 12);
  const byProj = (a, b) => (b.projected_points ?? -1) - (a.projected_points ?? -1);

  const pickOpponent = (rng, avail, counts, round) => {
    const needs = rosterNeeds(counts, slots, teams);
    // Consider the top of the market; in the last two rounds add the best K/DEF,
    // which sit past any market cutoff but are what teams actually take then.
    const lateK = round >= draft.rounds - 1;
    const top = lateK
      ? [...avail.slice(0, 40), ...avail.filter(p => p.position === 'K' || p.position === 'DEF').sort(byProj).slice(0, 6)]
      : avail.slice(0, 40);
    const best = top[0].market_rank;
    const tau = 2.5 + best * 0.08;
    let sum = 0; const w = new Array(top.length);
    for (let i = 0; i < top.length; i++) {
      const p = top[i];
      const isKD = p.position === 'K' || p.position === 'DEF';
      // K/DEF market ranks are noise: in the last two rounds treat them as
      // level with the top of the board for a team that still needs one.
      let wi = (isKD && lateK ? 1 : Math.exp(-Math.max(0, p.market_rank - best) / tau)) * interest(needs, p.position);
      if (isKD && !lateK) wi *= 0.02;
      w[i] = wi; sum += wi;
    }
    let r = rng() * sum;
    for (let i = 0; i < top.length; i++) { r -= w[i]; if (r <= 0) return top[i]; }
    return top[top.length - 1];
  };

  const pickMine = (avail, counts, round) => {
    const needs = rosterNeeds(counts, slots, teams);
    const roundsLeft = draft.rounds - round + 1;
    const flexOpen = (needs.starters.FLEX ?? 0) > 0;
    // Same candidate rule as rankTargets: top of the market, the top of each
    // position by projection, and K/DEF once the last two rounds arrive.
    const kdWanted = pos => roundsLeft <= 2 && (needs.starters[pos] ?? 0) > 0;
    const cands = new Map(avail.slice(0, 60).filter(p => !['K', 'DEF'].includes(p.position) || kdWanted(p.position)).map(p => [p.player_id, p]));
    for (const pos of ['QB', 'RB', 'WR', 'TE']) avail.filter(p => p.position === pos).sort(byProj).slice(0, 8).forEach(p => cands.set(p.player_id, p));
    for (const pos of ['K', 'DEF']) if (kdWanted(pos)) avail.filter(p => p.position === pos).sort(byProj).slice(0, 2).forEach(p => cands.set(p.player_id, p));
    let best = null, bestScore = -Infinity;
    for (const p of cands.values()) {
      const pos = p.position;
      const startsHere = (needs.starters[pos] ?? 0) > 0 || (flexOpen && FLEX_ELIGIBLE.includes(pos));
      // Same need weights as rankTargets — the simulated "me" must draft like the board.
      const needWeight = startsHere ? 1
        : (needs.depth[pos] ?? 0) > 0 ? (['QB', 'TE'].includes(pos) ? 0.4 * depthW : pos === 'RB' ? depthW + 0.05 : depthW)
        : ['QB', 'TE'].includes(pos) ? 0.03 : 0.2;
      const vorp = p.projected_points - (replacement[pos] ?? 0);
      // Mirrors rankTargets: P(used) × max(0, edge) plus a usability tie-break.
      let score = Math.max(0, vorp) * needWeight + (startsHere ? 4 : needWeight * 5)
        - 0.4 * (['K', 'DEF'].includes(pos) ? 0 : Math.min(p.market_rank, 60));
      if (pos === 'K' && roundsLeft > 1) score -= 80;
      if (pos === 'DEF' && roundsLeft > 2) score -= 60;
      // Never leave a starting slot empty for the last rounds.
      if (roundsLeft <= 2 && (needs.starters[pos] ?? 0) > 0) score += 40;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  };

  const runOne = (candidate, rng) => {
    const avail = pool.slice();
    const counts = Object.fromEntries(Object.entries(baseCounts).map(([s, c]) => [s, { ...c }]));
    const mine = myPicksNow.slice();
    const remove = p => { const i = avail.indexOf(p); if (i >= 0) avail.splice(i, 1); };
    const take = (slot, p, n) => {
      remove(p);
      counts[slot][p.position] = (counts[slot][p.position] ?? 0) + 1;
      if (slot === draft.my_slot) mine.push({ ...p, pick_number: n, player_id: p.player_id });
    };
    let nextExpect = null;
    for (let n = firstPick; n <= total; n++) {
      if (!avail.length) break;             // pool exhausted: score what was drafted
      const slot = slotForPick(n, teams);
      const round = Math.ceil(n / teams);
      if (slot === draft.my_slot) {
        if (n === myFirst) {
          const c = avail.find(p => p.player_id === candidate.player_id);
          if (!c) return null;             // sniped before my turn in this world
          take(slot, c, n);
        } else {
          if (nextExpect === null) nextExpect = avail.slice(0, 30);
          take(slot, pickMine(avail, counts[slot], round), n);
        }
      } else {
        take(slot, pickOpponent(rng, avail, counts[slot], round), n);
      }
    }
    return { value: rosterValue(mine, slots, replacement), roster: mine, nextExpect };
  };

  const out = [];
  for (const cand of cands) {
    const values = []; let sniped = 0;
    const survivorsNext = new Map();
    const finalCounts = {};
    for (let s = 0; s < sims; s++) {
      const r = runOne(cand, mulberry32(seed + s));
      if (!r) { sniped++; continue; }
      values.push(r.value);
      for (const p of r.roster) finalCounts[p.position] = (finalCounts[p.position] ?? 0) + 1;
      // Best expected at my following pick, by position, for the note.
      const seen = new Set();
      for (const p of r.nextExpect ?? []) {
        if (seen.has(p.position)) continue;
        seen.add(p.position);
        survivorsNext.set(p.name, (survivorsNext.get(p.name) ?? 0) + 1);
      }
    }
    if (!values.length) { out.push({ player_id: cand.player_id, name: cand.name, position: cand.position, sniped_pct: 100, expected: null }); continue; }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    const n = values.length;
    out.push({
      player_id: cand.player_id, name: cand.name, position: cand.position, team_abbr: cand.team_abbr,
      expected: +mean.toFixed(1), sd: +sd.toFixed(1), sims: n,
      sniped_pct: Math.round(100 * sniped / sims),
      typical_build: Object.entries(finalCounts).map(([pos, c]) => `${pos} ${(c / n).toFixed(1)}`).join(', '),
      likely_next: [...survivorsNext.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([name, c]) => ({ name, pct: Math.round(100 * c / n) }))
    });
  }
  out.sort((a, b) => (b.expected ?? -1) - (a.expected ?? -1));
  const best = out.find(o => o.expected != null);
  for (const o of out) o.delta = o.expected != null && best ? +(o.expected - best.expected).toFixed(1) : null;
  return { pick_number: myFirst, sims, candidates: out, generated_at: new Date().toISOString() };
}
