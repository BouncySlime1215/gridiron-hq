/**
 * Lineups built for the outcome you actually need, not the highest average.
 *
 * Every lineup tool in this app — and almost every one anywhere — maximises
 * EXPECTED points. That is the right objective exactly once: when you are
 * favoured and want to bank the median. It is the wrong objective when you are
 * an underdog, when you are chasing a playoff seed, and it is catastrophically
 * wrong in a daily-fantasy tournament, where finishing at the median wins
 * nothing at all.
 *
 * What those situations need is P(score >= some target), and that quantity is
 * governed by CORRELATION rather than by any individual projection. Two
 * lineups with identical expected points have very different ceilings if one
 * of them stacks a quarterback with his own receiver: when the QB has a big
 * day the receiver usually does too, so their good weeks arrive together and
 * the joint distribution grows a fat right tail. Sampling players
 * independently — which is what a naive optimiser does — assumes that shared
 * variance cancels out, and systematically understates the ceiling of exactly
 * the lineups that win tournaments.
 *
 * We already have the machinery to do this properly:
 *   `correlation.js`   Gaussian copula over archetype correlations
 *   `projections.js`   per-player weekly outcome distributions
 *   `trade-engine.js`  the league's real slot configuration
 *
 * The app has even been TELLING the user to do this — self-scout emits "you
 * need variance, target boom-rate players" — while providing no way to act on
 * it. This is the missing half.
 *
 * WEEKLY-RANGE-ONE: the draws are the league's one world (league-world.js), the
 * correlated runs the title odds are played on, and a lineup's floor, median and
 * ceiling are lineup-week-range.js's p10 / p50 / p90 of its run totals, the same
 * numbers every other page prints for that lineup-week. This module used to build
 * its own outcome pools and its own copula over the candidates (outcomePools /
 * worldOutcomePools); those are gone. What stays its own is the objective: the
 * search for the lineup that maximises P(total >= target) on those runs.
 */
import { row } from '../db/index.js';
import { deriveFormat } from './format.js';
import { assetUniverse, loadRosters, lineupSlots } from './trade-engine.js';
import { irOnRoster } from './lineup-brain.js';
import { oneWorldFlag, oneWorldPreviewFields } from './one-world.js';
import { leagueWorld, worldStamp } from './league-world.js';
import { lineupWeekTotals, rangeOfTotals, quantileAt, worldWeekMeans } from './lineup-week-range.js';

const SEASON = Number(process.env.NFL_SEASON) || 2026;
const SCORED = new Set(['QB', 'RB', 'WR', 'TE']);
const FLEX_ELIGIBLE = { FLEX: ['RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['RB', 'WR'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], OP: ['QB', 'RB', 'WR', 'TE'] };

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const r4 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(4));

/**
 * Each candidate who plays in the world's week, with his mean there (the number
 * the title odds set lineups on). A player on bye or without a pool has no draw
 * that week and is not a candidate.
 */
function worldCandidates(world, players, week) {
  const means = worldWeekMeans(world, week);
  if (!means) return [];
  return players
    .filter(p => SCORED.has(p.position) && means.has(p.id))
    .map(p => ({ player: p, mean: means.get(p.id) }));
}

/** Every legal assignment of a candidate set to the league's slots, greedily. */
function fillSlots(chosen, slots) {
  const used = new Set();
  const filled = [];
  for (const slot of slots.filter(s => SCORED.has(s))) {
    const pick = chosen.find(c => !used.has(c.player.id) && c.player.position === slot);
    if (pick) used.add(pick.player.id);
    filled.push({ slot, pick: pick ?? null });
  }
  for (const slot of slots.filter(s => FLEX_ELIGIBLE[s])) {
    const ok = FLEX_ELIGIBLE[slot];
    const pick = chosen.find(c => !used.has(c.player.id) && ok.includes(c.player.position));
    if (pick) used.add(pick.player.id);
    filled.push({ slot, pick: pick ?? null });
  }
  return filled;
}

/**
 * Score one lineup on the world's runs: its weekly range from the one producer
 * (lineup-week-range.js), its mean, its 99th percentile off the same run totals,
 * and P(score >= target) — the objective a tournament actually pays.
 */
function scoreLineup(world, week, picks, target) {
  const { totals } = lineupWeekTotals(world, picks.map(c => c.player.id), week);
  const range = rangeOfTotals(totals);
  const sorted = Float64Array.from(totals).sort();
  let hits = 0;
  if (target != null) for (const t of totals) if (t >= target) hits++;
  return { mean: range.mean, floor: range.floor, median: range.median, ceiling: range.ceiling,
    p99: r2(quantileAt(sorted, 0.99)), hit_probability: target == null ? null : r4(hits / totals.length) };
}

/**
 * The ceiling-optimal lineup for one team in one week.
 *
 * @param objective 'ceiling' maximises P(score >= target) — the tournament and
 *   underdog objective. 'mean' reproduces the classic highest-average lineup,
 *   kept so the two can be compared side by side, which is the whole point.
 * @param target the score to beat. The default is NOT "a stretch above the
 *   team's own median", which this line claimed for as long as it existed: it
 *   is `naiveScore.ceiling`, the one producer's p90 (lineup-week-range.js) of
 *   the highest-mean lineup, scored on the same world runs every candidate
 *   lineup is scored on. So the bar is "a good week from the lineup
 *   you would have started anyway", which is a harder and more useful question
 *   than beating a median.
 *
 *   Worth naming rather than leaving implicit: that target is built from the
 *   SAME projections as the candidate pool, so a change to how those
 *   projections are configured moves the pool and the bar together, and a
 *   `hit_probability` is only comparable against another run under the same
 *   configuration. Passing an explicit `target` is what makes it comparable
 *   across runs.
 */
export function ceilingLineup(leagueId, {
  teamId = null, week = 1, season = SEASON, objective = 'ceiling',
  target = null, candidates = 14
} = {}) {
  const lg = row('SELECT * FROM leagues WHERE id = ?', leagueId);
  if (!lg?.payload) return { error: 'league not synced yet' };

  const { formatKey } = deriveFormat(lg);
  const assets = assetUniverse(lg, formatKey);
  const teams = loadRosters(lg, assets);
  const me = teams.find(t => t.roster_id === String(teamId ?? lg.my_team_id)) ?? teams[0];
  if (!me) return { error: 'team not found in this league' };
  const slots = lineupSlots(lg);

  // IR players are never candidates: ESPN's IR slot or injured-reserve status, the
  // rule Start/Sit (lineup-brain.js#irOnRoster), the matchup card, the waiver board
  // and the League Hub card all use. This solved on every rostered player, so on the
  // 2026-W2 live check league 4's lineup put Zach Charbonnet (IR slot, OUT) at FLEX.
  const irReason = irOnRoster(lg, me.roster_id, me.players);
  const oneWorld = oneWorldFlag();
  const world = leagueWorld(lg);
  if (world.fail) return world.fail;
  const wk = Number(week);
  if (!worldWeekMeans(world, wk)) return { error: `week ${week} is not one of the simulated weeks` };
  const playable = me.players.filter(p => !irReason.has(p.id));
  const pools = worldCandidates(world, playable, wk)
    .sort((a, b) => b.mean - a.mean)
    .slice(0, candidates);
  if (pools.length < slots.length) {
    return { error: `only ${pools.length} playable candidates for ${slots.length} slots in week ${week}` };
  }
  // Every lineup is scored on the world's SAME runs, so two lineups differ only by
  // who is in them and never by sampling luck.
  const score = (picks, tgt) => scoreLineup(world, wk, picks, tgt);

  // A default target set from the team's own top-heavy lineup: beating your own
  // median is not a goal, beating a strong week is.
  const naive = fillSlots([...pools].sort((a, b) => b.mean - a.mean), slots)
    .map(f => f.pick).filter(Boolean);
  const naiveScore = score(naive, null);
  const effectiveTarget = target ?? naiveScore.ceiling;

  // Search: start from the highest-mean lineup and try single swaps until no
  // swap improves the objective. Exhaustive enumeration is factorial and
  // unnecessary — the objective is smooth in one substitution at a time.
  const objectiveOf = picks => {
    const s = score(picks, effectiveTarget);
    return objective === 'mean' ? s.mean : s.hit_probability;
  };

  let best = naive, bestVal = objectiveOf(naive);
  let improved = true, passes = 0;
  while (improved && passes < 6) {
    improved = false; passes++;
    for (let i = 0; i < best.length; i++) {
      for (const cand of pools) {
        if (best.some(b => b.player.id === cand.player.id)) continue;
        const trial = best.slice();
        trial[i] = cand;
        // The swap must still produce a legal lineup for this league's slots.
        const legal = fillSlots(trial, slots);
        if (legal.some(f => !f.pick)) continue;
        const picks = legal.map(f => f.pick);
        const val = objectiveOf(picks);
        if (val > bestVal) { best = picks; bestVal = val; improved = true; }
      }
    }
  }

  const bestFilled = fillSlots(best, slots);
  const bestScore = score(best, effectiveTarget);
  const naiveFilled = fillSlots(naive, slots);
  const naiveFull = score(naive, effectiveTarget);

  // Which stacks the optimiser actually chose — the mechanism behind any
  // ceiling gain, surfaced so the recommendation is inspectable rather than
  // a black box telling you to bench your best player.
  const byTeam = new Map();
  for (const p of best) {
    const t = p.player.team_abbr;
    if (!t) continue;
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t).push(`${p.player.name} (${p.player.position})`);
  }
  const stacks = [...byTeam.entries()].filter(([, v]) => v.length > 1)
    .map(([team, players]) => ({ team, players }));

  return {
    league: lg.name, team: me.owner, season, week,
    // `trials` is the world's run count: every lineup is scored on the title odds' runs.
    objective, target: effectiveTarget, trials: world.runs, candidates_considered: pools.length,
    // Left out because they are on IR, with why.
    on_ir: me.players.filter(p => irReason.has(p.id))
      .map(p => ({ name: p.name, position: p.position, why: irReason.get(p.id) })),
    lineup: bestFilled.map(f => ({ slot: f.slot, player: f.pick.player.name,
      position: f.pick.player.position, team: f.pick.player.team_abbr,
      mean_points: r2(f.pick.mean) })),
    distribution: bestScore,
    // The comparison that makes the case: same roster, same draws, different
    // objective. If these are identical the roster has no ceiling lever and
    // saying so is more useful than manufacturing a difference.
    versus_highest_mean: {
      lineup: naiveFilled.map(f => ({ slot: f.slot, player: f.pick?.player.name ?? null })),
      distribution: naiveFull,
      mean_given_up: r2(bestScore.mean - naiveFull.mean),
      ceiling_gained: r2(bestScore.ceiling - naiveFull.ceiling),
      hit_probability_gained: r4((bestScore.hit_probability ?? 0) - (naiveFull.hit_probability ?? 0))
    },
    stacks,
    one_world: worldStamp(lg, world), ...oneWorldPreviewFields(oneWorld),
    note: 'Scored on the league world\'s correlated runs (the title odds\' own draws), so a quarterback and ' +
      'his own receiver have their good weeks together. Every lineup is evaluated against the ' +
      'same runs, so a difference between them is never sampling luck. Floor / median / ceiling are ' +
      'the lineup total\'s p10 / p50 / p90.'
  };
}
